import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeAudit } from "./audit.js";
import { hashApiKey } from "./crypto.js";
import { pool, type UserRow } from "./db.js";
import { callGatewayTool, visibleTools } from "./upstream.js";

type Session = { transport: StreamableHTTPServerTransport; userId: string };
const sessions = new Map<string, Session>();

type BearerUser = { id: string; email: string; role: "admin" | "member" };

async function userFromBearer(header: string | undefined): Promise<BearerUser | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
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
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const user = await reloadUser(userId);
    if (!user) throw new Error("User no longer exists");
    const started = new Date();
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const outcome = await callGatewayTool(user, name, args);
    await writeAudit({
      userId: user.id,
      userEmail: user.email,
      serverSlug: outcome.serverSlug,
      toolName: name,
      startedAt: started,
      durationMs: Date.now() - started.getTime(),
      outcome: outcome.result.isError ? "error" : "success",
      errorMessage: outcome.errorMessage,
    });
    console.log(
      `tool ${name} user=${user.email} outcome=${outcome.result.isError ? "error" : "success"} ${Date.now() - started.getTime()}ms`,
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
  const sessionId = req.header("mcp-session-id");
  try {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (session.userId !== user.id) {
        rpcError(res, 401, -32000, "Session belongs to another user");
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, userId: user.id });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = buildServer(user.id);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      rpcError(res, 404, -32001, "Session not found");
      return;
    }
    rpcError(res, 400, -32000, "Bad Request: session id required");
  } catch (error) {
    console.error("mcp request failed", error);
    if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
  }
}

export async function closeMcpSessions(): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      await session.transport.close().catch(() => undefined);
    }),
  );
  sessions.clear();
}
