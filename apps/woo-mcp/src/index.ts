import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createProduct, getOrder, listOrders, listProducts, updateOrderStatus, wooReady } from "./woo.js";

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

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce", version: "0.1.0" });

  server.registerTool(
    "list_products",
    {
      description: "List published products in the WooCommerce store.",
      inputSchema: {
        search: z.string().optional().describe("Optional name search"),
        perPage: z.number().int().min(1).max(50).optional().describe("Page size, default 20"),
      },
    },
    async ({ search, perPage }) => {
      try {
        return text(await listProducts(search, perPage));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_product",
    {
      description: "Create and publish a simple product.",
      inputSchema: {
        name: z.string().min(1).describe("Product name"),
        regularPrice: z.coerce.string().min(1).describe("Price as a decimal string, for example 18.00"),
        description: z.string().optional(),
      },
    },
    async (input) => {
      try {
        return text(await createProduct(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_orders",
    {
      description: "List orders, newest first. Use after as an ISO-8601 UTC timestamp to restrict to orders created after that time.",
      inputSchema: {
        after: z.string().optional().describe("ISO-8601 lower bound on date created, UTC"),
        before: z.string().optional().describe("ISO-8601 upper bound on date created, UTC"),
        status: z
          .enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"])
          .optional(),
        perPage: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => {
      try {
        return text(await listOrders(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Get one order by its numeric id.",
      inputSchema: { id: z.coerce.number().int().positive() },
    },
    async ({ id }) => {
      try {
        return text(await getOrder(id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "update_order_status",
    {
      description: "Change an order's status.",
      inputSchema: {
        id: z.coerce.number().int().positive(),
        status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
      },
    },
    async ({ id, status }) => {
      try {
        return text(await updateOrderStatus(id, status));
      } catch (error) {
        return failure(error);
      }
    },
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
app.get("/readyz", async (_req, res) => {
  const ready = await wooReady();
  res.status(ready ? 200 : 503).json({ ok: ready });
});
app.post("/mcp", (req, res) => {
  void handleMcp(req, res);
});
app.get("/mcp", (req, res) => {
  void handleMcp(req, res);
});
app.delete("/mcp", (req, res) => {
  void handleMcp(req, res);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`woo-mcp listening on ${port}`));
