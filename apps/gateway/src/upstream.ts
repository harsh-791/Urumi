import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";
import { decryptString } from "./crypto.js";
import { pool, type McpServerRow } from "./db.js";
import { assertUrlAllowed } from "./ssrf.js";
import { collectTools, splitTool, toolAllowed, type GatewayTool, type UpstreamTool } from "./tools.js";

type Held = { key: string; client: Client; transport: StreamableHTTPClientTransport };

const clients = new Map<string, Held>();
const locks = new Map<string, Promise<void>>();

async function withLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    id,
    previous.then(() => gate),
  );
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
  }
}

function cacheKey(server: McpServerRow): string {
  return `${server.url}|${server.auth_type}|${server.auth_header_name ?? ""}|${server.credential_ciphertext ?? ""}`;
}

function credentialHeaders(server: McpServerRow): Record<string, string> {
  if (!server.credential_ciphertext || server.auth_type === "none") return {};
  const secret = decryptString(server.credential_ciphertext, config.credentialKey);
  if (server.auth_type === "bearer") return { Authorization: `Bearer ${secret}` };
  const header = server.auth_header_name || "X-API-Key";
  return { [header]: secret };
}

async function evict(id: string): Promise<void> {
  const held = clients.get(id);
  clients.delete(id);
  if (!held) return;
  await held.client.close().catch(() => undefined);
}

async function clientFor(server: McpServerRow): Promise<Client> {
  const key = cacheKey(server);
  const existing = clients.get(server.id);
  if (existing && existing.key === key) return existing.client;
  await evict(server.id);

  await assertUrlAllowed(server.url, { allowClusterUrls: config.allowClusterUrls });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: credentialHeaders(server),
      redirect: "error",
    },
  });
  const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
  await client.connect(transport, { timeout: config.callTimeoutMs });
  clients.set(server.id, { key, client, transport });
  return client;
}

async function useClient<T>(server: McpServerRow, run: (client: Client) => Promise<T>): Promise<T> {
  return withLock(server.id, async () => {
    try {
      const client = await clientFor(server);
      return await run(client);
    } catch (error) {
      await evict(server.id);
      throw error;
    }
  });
}

export async function listUpstreamTools(server: McpServerRow): Promise<UpstreamTool[]> {
  return useClient(server, async (client) => {
    const result = await client.listTools(undefined, { timeout: config.listTimeoutMs });
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }));
  });
}

export async function visibleTools(user: { role: "admin" | "member" }): Promise<{
  tools: GatewayTool[];
  failures: { slug: string; message: string }[];
}> {
  const result = await pool.query<McpServerRow>(
    "SELECT * FROM mcp_servers WHERE enabled = true ORDER BY created_at ASC",
  );
  return collectTools(
    result.rows,
    async (slug) => {
      const server = result.rows.find((row) => row.slug === slug);
      if (!server) return [];
      return listUpstreamTools(server);
    },
    {
      timeoutMs: config.listTimeoutMs + 500,
      allow: (name) => toolAllowed(user.role, name),
    },
  );
}

export type ToolCallOutcome = {
  result: { content: { type: "text"; text: string }[]; isError?: boolean };
  serverSlug: string | null;
  errorMessage: string | null;
};

export async function callGatewayTool(
  user: { id: string; email: string; role: "admin" | "member" },
  prefixedName: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const parsed = splitTool(prefixedName);
  if (!parsed) {
    return fail(null, `Unknown tool ${prefixedName}. Tool names look like server__tool.`);
  }
  if (!toolAllowed(user.role, prefixedName)) {
    return fail(parsed.slug, `Not allowed to call ${prefixedName}`);
  }
  const found = await pool.query<McpServerRow>("SELECT * FROM mcp_servers WHERE slug = $1", [parsed.slug]);
  const server = found.rows[0];
  if (!server) return fail(parsed.slug, `Unknown MCP server ${parsed.slug}`);
  if (!server.enabled) return fail(parsed.slug, `MCP server ${parsed.slug} is disabled`);

  try {
    const result = await useClient(server, (client) =>
      client.callTool({ name: parsed.name, arguments: args }, undefined, { timeout: config.callTimeoutMs }),
    );
    const isError = Boolean(result && typeof result === "object" && "isError" in result && result.isError);
    const text = toolText(result);
    return {
      serverSlug: parsed.slug,
      errorMessage: isError ? text.slice(0, 500) : null,
      result: {
        content: [{ type: "text", text }],
        isError,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(parsed.slug, `Upstream ${parsed.slug} failed: ${message}`);
  }
}

function toolText(result: unknown): string {
  const content =
    result && typeof result === "object" && "content" in result && Array.isArray(result.content)
      ? result.content
      : [];
  const text = content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
  return text || JSON.stringify(result);
}

function fail(serverSlug: string | null, message: string): ToolCallOutcome {
  return {
    serverSlug,
    errorMessage: message.slice(0, 500),
    result: { content: [{ type: "text", text: message }], isError: true },
  };
}

export async function probeServers(): Promise<void> {
  const result = await pool.query<McpServerRow>("SELECT * FROM mcp_servers ORDER BY created_at ASC");
  await Promise.all(
    result.rows.map(async (server) => {
      if (server.host_state === "pending" || server.host_state === "deleting") return;
      if (!server.enabled) {
        await pool.query(
          `UPDATE mcp_servers SET status = 'disabled', status_detail = NULL, last_checked_at = now(), updated_at = now() WHERE id = $1`,
          [server.id],
        );
        return;
      }
      try {
        await listUpstreamTools(server);
        await pool.query(
          `UPDATE mcp_servers SET status = 'connected', status_detail = NULL, last_checked_at = now(), updated_at = now() WHERE id = $1`,
          [server.id],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pool.query(
          `UPDATE mcp_servers
           SET status = 'unreachable', status_detail = $2, last_checked_at = now(), updated_at = now()
           WHERE id = $1`,
          [server.id, message.slice(0, 500)],
        );
      }
    }),
  );
}

export async function closeUpstreams(): Promise<void> {
  await Promise.all([...clients.keys()].map((id) => evict(id)));
}
