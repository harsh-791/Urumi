import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const sessions = new Map<string, StreamableHTTPServerTransport>();

function authorized(req: Request): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const got = Buffer.from(token);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "clock", version: "0.1.0" });
  server.registerTool(
    "current_time",
    {
      description: "Return the current UTC time. Use this before asking which orders arrived today.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ utc: new Date().toISOString(), timezone: "UTC" }, null, 2),
        },
      ],
    }),
  );
  return server;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  if (!authorized(req)) {
    rpcError(res, 401, -32000, "Unauthorized");
    return;
  }
  const sessionId = req.header("mcp-session-id");
  try {
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await buildServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      rpcError(res, 404, -32001, "Session not found");
      return;
    }
    rpcError(res, 400, -32000, "Bad Request: session id required");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz", (_req, res) => res.json({ ok: true }));
app.post("/mcp", (req, res) => void handleMcp(req, res));
app.get("/mcp", (req, res) => void handleMcp(req, res));
app.delete("/mcp", (req, res) => void handleMcp(req, res));
app.listen(Number(process.env.PORT ?? 8080), () => console.log("clock-mcp listening"));
