import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeAudit } from "./audit.js";
import { CALL_TOOL, resolveModelCall, SEARCH_TOOL, toolsForClient } from "./catalog.js";
import { config } from "./config.js";
import { hashApiKey } from "./crypto.js";
import { pool, type UserRow } from "./db.js";
import { recordToolCall } from "./metrics.js";
import { userIdForAccessToken } from "./oauth.js";
import { takeRate } from "./rate.js";
import { callGatewayTool, visibleTools } from "./upstream.js";

const live = new Set<StreamableHTTPServerTransport>();

type BearerUser = { id: string; email: string; role: "admin" | "member" };

async function userFromBearer(header: string | undefined): Promise<BearerUser | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  if (token.startsWith("uro_")) {
    const userId = await userIdForAccessToken(token);
    if (!userId) return null;
    return reloadUser(userId);
  }
  const result = await pool.query<UserRow>(
    `SELECT users.* FROM api_keys
     JOIN users ON users.id = api_keys.user_id
     WHERE api_keys.key_hash = $1 AND api_keys.revoked_at IS NULL`,
    [hashApiKey(token)],
  );
  const user = result.rows[0];
  if (!user) return null;
  await pool.query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [hashApiKey(token)]);
  return { id: user.id, email: user.email, role: user.role };
}

async function reloadUser(id: string): Promise<BearerUser | null> {
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  const user = result.rows[0];
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role };
}

function buildServer(userId: string): Server {
  const server = new Server(
    { name: "urumi-gateway", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const user = await reloadUser(userId);
    if (!user) throw new Error("User no longer exists");
    const { tools } = await visibleTools(user);
    return { tools: toolsForClient(tools, config.toolDirectLimit) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const user = await reloadUser(userId);
    if (!user) throw new Error("User no longer exists");
    const started = new Date();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (name === SEARCH_TOOL || name === CALL_TOOL) {
      const { tools } = await visibleTools(user);
      const resolved = resolveModelCall(tools, name, args);
      if (resolved.kind === "search" || resolved.kind === "error") {
        const ok = resolved.kind === "search";
        const text = resolved.kind === "search" ? resolved.text : resolved.message;
        const durationMs = Date.now() - started.getTime();
        recordToolCall("gateway", ok ? "success" : "error", durationMs);
        await writeAudit({
          userId: user.id,
          userEmail: user.email,
          serverSlug: "gateway",
          toolName: name,
          startedAt: started,
          durationMs,
          outcome: ok ? "success" : "error",
          errorMessage: ok ? null : text.slice(0, 500),
        });
        return { content: [{ type: "text" as const, text }], isError: !ok };
      }
      const outcome = await callGatewayTool(user, resolved.name, resolved.arguments);
      const durationMs = Date.now() - started.getTime();
      recordToolCall(outcome.serverSlug ?? "gateway", outcome.result.isError ? "error" : "success", durationMs);
      await writeAudit({
        userId: user.id,
        userEmail: user.email,
        serverSlug: outcome.serverSlug,
        toolName: resolved.name,
        startedAt: started,
        durationMs,
        outcome: outcome.result.isError ? "error" : "success",
        errorMessage: outcome.errorMessage,
      });
      console.log(
        `tool ${resolved.name} user=${user.email} outcome=${outcome.result.isError ? "error" : "success"} ${durationMs}ms`,
      );
      return outcome.result;
    }
    const outcome = await callGatewayTool(user, name, args);
    const durationMs = Date.now() - started.getTime();
    recordToolCall(outcome.serverSlug ?? "gateway", outcome.result.isError ? "error" : "success", durationMs);
    await writeAudit({
      userId: user.id,
      userEmail: user.email,
      serverSlug: outcome.serverSlug,
      toolName: name,
      startedAt: started,
      durationMs,
      outcome: outcome.result.isError ? "error" : "success",
      errorMessage: outcome.errorMessage,
    });
    console.log(
      `tool ${name} user=${user.email} outcome=${outcome.result.isError ? "error" : "success"} ${durationMs}ms`,
    );
    return outcome.result;
  });
  return server;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export async function handleMcp(req: Request, res: Response): Promise<void> {
  const user = await userFromBearer(req.header("authorization"));
  if (!user) {
    rpcError(res, 401, -32000, "Unauthorized");
    return;
  }
  if (req.method !== "POST") {
    res.set("Allow", "POST");
    rpcError(res, 405, -32000, "Method not allowed");
    return;
  }
  const allowed = await takeRate(`user:${user.id}`, config.rateLimitPerMinute);
  if (!allowed) {
    res.set("Retry-After", "60");
    rpcError(res, 429, -32000, "Too many requests. Try again in a minute.");
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(user.id);
  live.add(transport);
  res.on("close", () => {
    live.delete(transport);
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("mcp request failed", error);
    if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
  }
}

export async function closeMcpSessions(): Promise<void> {
  await Promise.all([...live].map((transport) => transport.close().catch(() => undefined)));
  live.clear();
}
