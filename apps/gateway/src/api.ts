import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { encryptString, generateApiKey, hashApiKey, hashPassword, verifyPassword } from "./crypto.js";
import { pool, type McpServerRow, type Role, type UserRow } from "./db.js";
import { HttpError } from "./errors.js";
import { assertUrlAllowed, SsrfError } from "./ssrf.js";
import { toolAllowed, validSlug } from "./tools.js";
import { listUpstreamTools, probeServers } from "./upstream.js";
import { runChat, type ChatMessage } from "./chat.js";
import { hostedUrl, validImage } from "./hostedplan.js";
import { decideAuthorization, describeRequest, requireOAuthStore } from "./oauth.js";

const COOKIE = "urumi_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; email: string; role: Role };

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function setSessionCookie(res: Response, id: string): void {
  const flags = [`${COOKIE}=${id}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${SESSION_MS / 1000}`];
  if (config.cookieSecure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(res: Response): void {
  const flags = [`${COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (config.cookieSecure) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = readCookie(req.header("cookie"), COOKIE);
  if (!id) return next();
  const result = await pool.query<UserRow>(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = $1 AND sessions.expires_at > now()`,
    [id],
  );
  const user = result.rows[0];
  if (user) req.user = { id: user.id, email: user.email, role: user.role };
  next();
}

export function requireUser(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "Login required");
  return req.user;
}

export function requireAdmin(req: Request): SessionUser {
  const user = requireUser(req);
  if (user.role !== "admin") throw new HttpError(403, "Admin only");
  return user;
}

function publicServer(row: McpServerRow, role: Role, tools: { name: string; description?: string }[]) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: role === "admin" ? row.url : undefined,
    authType: row.auth_type,
    authHeaderName: row.auth_header_name,
    hasCredential: Boolean(row.credential_ciphertext),
    image: row.image,
    hostState: row.host_state,
    enabled: row.enabled,
    status: row.status,
    statusDetail: row.status_detail,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    tools: tools
      .map((tool) => ({ name: `${row.slug}__${tool.name}`, description: tool.description ?? "" }))
      .filter((tool) => toolAllowed(role, tool.name)),
  };
}

async function toolsFor(row: McpServerRow): Promise<{ name: string; description?: string }[]> {
  if (!row.enabled) return [];
  try {
    return await listUpstreamTools(row);
  } catch {
    return [];
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, "Invalid email or password");
  }
  const id = randomUUID();
  await pool.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [
    id,
    user.id,
    new Date(Date.now() + SESSION_MS),
  ]);
  setSessionCookie(res, id);
  res.json({ id: user.id, email: user.email, role: user.role });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const id = readCookie(req.header("cookie"), COOKIE);
  if (id) await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  clearSessionCookie(res);
  res.json({ ok: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  res.json(user);
}

export async function listServers(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query<McpServerRow>("SELECT * FROM mcp_servers ORDER BY created_at ASC");
  const servers = await Promise.all(
    result.rows.map(async (row) => publicServer(row, user.role, await toolsFor(row))),
  );
  res.json({ servers });
}

export async function createServer(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const slug = String(req.body?.slug ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const image = String(req.body?.image ?? "").trim();
  let url = String(req.body?.url ?? "").trim();
  const authType = String(req.body?.authType ?? "none");
  const authHeaderName = optionalString(req.body?.authHeaderName);
  const credential = optionalString(req.body?.credential);
  if (!validSlug(slug)) throw new HttpError(400, "Slug must be a short lowercase name");
  if (!name) throw new HttpError(400, "Name is required");
  if (image && url) throw new HttpError(400, "Provide a URL or an image, not both");
  if (!image && !url) throw new HttpError(400, "A URL or an image is required");
  if (image && !validImage(image)) throw new HttpError(400, "Image must be a name and a tag, like urumi-clock-mcp:local");
  if (authType !== "none" && authType !== "bearer" && authType !== "header") {
    throw new HttpError(400, "authType must be none, bearer, or header");
  }
  if (authType === "header" && !authHeaderName) throw new HttpError(400, "Header name is required");
  let hostState: string | null = null;
  let status = "unknown";
  if (image) {
    url = hostedUrl(slug, config.stores.platformNamespace || "urumi");
    hostState = "pending";
    status = "provisioning";
  } else {
    await checkUrl(url);
  }
  try {
    await pool.query(
      `INSERT INTO mcp_servers
        (id, slug, name, url, auth_type, auth_header_name, credential_ciphertext, enabled, status, image, host_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10)`,
      [randomUUID(), slug, name, url, authType, authHeaderName, seal(authType, credential), status, image || null, hostState],
    );
  } catch (error) {
    if (isUnique(error)) throw new HttpError(409, "That slug is already registered");
    throw error;
  }
  void probeServers();
  res.status(201).json({ ok: true });
}

export async function updateServer(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const current = await pool.query<McpServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [req.params.id]);
  const row = current.rows[0];
  if (!row) throw new HttpError(404, "Server not found");

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
  const url = row.image ? row.url : req.body?.url !== undefined ? String(req.body.url).trim() : row.url;
  const authType = req.body?.authType !== undefined ? String(req.body.authType) : row.auth_type;
  const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : row.enabled;
  const authHeaderName =
    req.body?.authHeaderName !== undefined ? optionalString(req.body.authHeaderName) : row.auth_header_name;
  if (!name) throw new HttpError(400, "Name is required");
  if (authType !== "none" && authType !== "bearer" && authType !== "header") {
    throw new HttpError(400, "authType must be none, bearer, or header");
  }
  if (!row.image) await checkUrl(url);
  let ciphertext = row.credential_ciphertext;
  if (authType === "none") ciphertext = null;
  if (req.body?.credential) ciphertext = seal(authType, String(req.body.credential));
  const status = !enabled ? "disabled" : row.host_state === "pending" ? row.status : "unknown";
  await pool.query(
    `UPDATE mcp_servers
     SET name = $2, url = $3, auth_type = $4, auth_header_name = $5,
         credential_ciphertext = $6, enabled = $7, status = $8, updated_at = now()
     WHERE id = $1`,
    [row.id, name, url, authType, authHeaderName, ciphertext, enabled, status],
  );
  void probeServers();
  res.json({ ok: true });
}

export async function deleteServer(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const current = await pool.query<McpServerRow>("SELECT * FROM mcp_servers WHERE id = $1", [req.params.id]);
  const row = current.rows[0];
  if (!row) throw new HttpError(404, "Server not found");
  if (row.image) {
    await pool.query(
      `UPDATE mcp_servers SET host_state = 'deleting', enabled = false, status = 'deleting', updated_at = now() WHERE id = $1`,
      [row.id],
    );
    res.status(202).json({ ok: true });
    return;
  }
  await pool.query("DELETE FROM mcp_servers WHERE id = $1", [row.id]);
  res.json({ ok: true });
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const result = await pool.query<{ id: string; email: string; role: Role; created_at: Date }>(
    "SELECT id, email, role, created_at FROM users ORDER BY created_at ASC",
  );
  res.json({ users: result.rows });
}

export async function createUser(req: Request, res: Response): Promise<void> {
  requireAdmin(req);
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const role = String(req.body?.role ?? "member");
  if (!email.includes("@")) throw new HttpError(400, "Email is required");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (role !== "admin" && role !== "member") throw new HttpError(400, "Role must be admin or member");
  try {
    await pool.query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)", [
      randomUUID(),
      email,
      await hashPassword(password),
      role,
    ]);
  } catch (error) {
    if (isUnique(error)) throw new HttpError(409, "That email is already registered");
    throw error;
  }
  res.status(201).json({ ok: true });
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const admin = requireAdmin(req);
  if (req.params.id === admin.id) throw new HttpError(400, "You cannot remove yourself");
  const target = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [req.params.id]);
  const user = target.rows[0];
  if (!user) throw new HttpError(404, "User not found");
  if (user.role === "admin") {
    const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    if (admins.rowCount !== null && admins.rowCount <= 1) throw new HttpError(400, "Cannot remove the last admin");
  }
  await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
  res.json({ ok: true });
}

export async function listKeys(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query(
    `SELECT api_keys.id, api_keys.key_prefix, api_keys.label, api_keys.created_at, api_keys.revoked_at,
            api_keys.last_used_at, users.email AS user_email, users.id AS user_id
     FROM api_keys JOIN users ON users.id = api_keys.user_id
     WHERE ($1::text = 'admin' OR api_keys.user_id = $2)
     ORDER BY api_keys.created_at DESC`,
    [user.role, user.id],
  );
  res.json({ keys: result.rows });
}

export async function createKey(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const label = String(req.body?.label ?? "").slice(0, 80);
  let userId = user.id;
  if (req.body?.userId && req.body.userId !== user.id) {
    if (user.role !== "admin") throw new HttpError(403, "Admin only");
    const target = await pool.query("SELECT id FROM users WHERE id = $1", [req.body.userId]);
    if (!target.rows[0]) throw new HttpError(404, "User not found");
    userId = String(req.body.userId);
  }
  const key = generateApiKey();
  const id = randomUUID();
  await pool.query(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4, $5)",
    [id, userId, key.hash, key.prefix, label],
  );
  res.status(201).json({ id, prefix: key.prefix, plaintext: key.plaintext, label });
}

export async function revokeKey(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL AND ($2::text = 'admin' OR user_id = $3)`,
    [req.params.id, user.role, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, "Active key not found");
  res.json({ ok: true });
}

export async function listAudit(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query(
    `SELECT id, user_email, server_slug, tool_name, started_at, duration_ms, outcome, error_message
     FROM audit_log
     WHERE ($1::text = 'admin' OR user_id = $2)
     ORDER BY started_at DESC
     LIMIT 200`,
    [user.role, user.id],
  );
  res.json({ events: result.rows });
}

export async function oauthRequest(req: Request, res: Response): Promise<void> {
  requireUser(req);
  const described = await describeRequest(requireOAuthStore(), String(req.params.id ?? ""));
  res.json(described);
}

export async function oauthDecision(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const redirect = await decideAuthorization(requireOAuthStore(), {
    requestId: String(req.body?.requestId ?? ""),
    userId: user.id,
    allow: req.body?.allow === true,
  });
  res.json({ redirect });
}

export async function chat(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const messages = normalizeMessages(req.body?.messages);
  try {
    const result = await runChat(user, messages);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, message);
  }
}

function normalizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "messages is required");
  if (input.length > 30) throw new HttpError(400, "Too many messages");
  return input.map((item) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "Invalid message");
    const role = "role" in item ? item.role : "";
    const content = "content" in item ? item.content : "";
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
      throw new HttpError(400, "Invalid message");
    }
    if (content.length > 8000) throw new HttpError(400, "Message is too long");
    return { role, content };
  });
}

async function checkUrl(url: string): Promise<void> {
  try {
    await assertUrlAllowed(url, { allowClusterUrls: config.allowClusterUrls });
  } catch (error) {
    if (error instanceof SsrfError) throw new HttpError(400, error.message);
    throw error;
  }
}

function seal(authType: string, credential: string | null): string | null {
  if (authType === "none" || !credential) return null;
  return encryptString(credential, config.credentialKey);
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function isUnique(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function seedAdmin(): Promise<void> {
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [config.adminEmail]);
  if (existing.rows[0]) return;
  await pool.query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')", [
    randomUUID(),
    config.adminEmail,
    await hashPassword(config.adminPassword),
  ]);
  console.log(`seeded admin ${config.adminEmail}`);
}

export async function seedServers(): Promise<void> {
  const count = await pool.query("SELECT count(*)::int AS n FROM mcp_servers");
  if ((count.rows[0]?.n ?? 0) > 0) return;
  const seeds = [
    { slug: "woo", name: "WooCommerce", url: config.seed.wooUrl, token: config.seed.wooToken },
    { slug: "notes", name: "Team notes", url: config.seed.notesUrl, token: config.seed.notesToken },
    { slug: "clock", name: "Clock", url: config.seed.clockUrl, token: config.seed.clockToken },
  ];
  for (const seed of seeds) {
    if (!seed.url) continue;
    await pool.query(
      `INSERT INTO mcp_servers
        (id, slug, name, url, auth_type, credential_ciphertext, enabled, status)
       VALUES ($1, $2, $3, $4, $5, $6, true, 'unknown')`,
      [
        randomUUID(),
        seed.slug,
        seed.name,
        seed.url,
        seed.token ? "bearer" : "none",
        seed.token ? encryptString(seed.token, config.credentialKey) : null,
      ],
    );
  }
  console.log("seeded MCP servers");
}
