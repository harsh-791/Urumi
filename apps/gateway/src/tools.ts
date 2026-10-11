export type UpstreamTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type GatewayTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const WRITE_TOOLS = new Set(["create_product", "update_order_status"]);

export function prefixTool(slug: string, name: string): string {
  return `${slug}__${name}`;
}

export function splitTool(prefixed: string): { slug: string; name: string } | null {
  const index = prefixed.indexOf("__");
  if (index <= 0 || index + 2 >= prefixed.length) return null;
  return { slug: prefixed.slice(0, index), name: prefixed.slice(index + 2) };
}

export function validSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{0,31}$/.test(slug);
}

export function toolAllowed(role: "admin" | "member", prefixedName: string): boolean {
  if (role === "admin") return true;
  const parsed = splitTool(prefixedName);
  if (!parsed) return false;
  if (parsed.slug === "woo" && WRITE_TOOLS.has(parsed.name)) return false;
  return true;
}

function emptySchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

export async function collectTools(
  servers: { slug: string; name: string }[],
  list: (slug: string) => Promise<UpstreamTool[]>,
  options: { timeoutMs: number; allow: (prefixed: string) => boolean },
): Promise<{ tools: GatewayTool[]; failures: { slug: string; message: string }[] }> {
  const settled = await Promise.all(
    servers.map(async (server) => {
      try {
        const tools = await withTimeout(list(server.slug), options.timeoutMs, server.slug);
        return { ok: true as const, server, tools };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, server, message };
      }
    }),
  );

  const tools: GatewayTool[] = [];
  const failures: { slug: string; message: string }[] = [];
  for (const item of settled) {
    if (!item.ok) {
      failures.push({ slug: item.server.slug, message: item.message });
      continue;
    }
    for (const tool of item.tools) {
      if (!tool.name) continue;
      const name = prefixTool(item.server.slug, tool.name);
      if (name.length > 64) {
        failures.push({ slug: item.server.slug, message: `tool ${tool.name} is too long to expose` });
        continue;
      }
      if (!options.allow(name)) continue;
      const description = tool.description?.trim() || "No description from the upstream server.";
      tools.push({
        name,
        description: `[${item.server.name}] ${description}\nUpstream tool: ${tool.name}.`,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : emptySchema(),
      });
    }
  }
  return { tools, failures };
}

function withTimeout<T>(promise: Promise<T>, ms: number, slug: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Upstream ${slug} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
