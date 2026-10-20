import { splitTool, type GatewayTool } from "./tools.js";

export const SEARCH_TOOL = "search_tools";
export const CALL_TOOL = "call_tool";

export function metaTools(): GatewayTool[] {
  return [
    {
      name: SEARCH_TOOL,
      description:
        "Find tools by store, name, or purpose. Returns matching tool names, descriptions, and argument schemas. Call this before call_tool.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match, such as linen orders or current time" },
          limit: { type: "integer", description: "Maximum matches. Default 8, maximum 20." },
        },
        required: ["query"],
      },
    },
    {
      name: CALL_TOOL,
      description:
        "Run one tool by the exact name returned from search_tools. Put that tool's arguments in arguments.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Prefixed tool name such as linen__list_orders" },
          arguments: { type: "object", description: "Arguments for that tool" },
        },
        required: ["name"],
      },
    },
  ];
}

export function toolsForClient(tools: GatewayTool[], directLimit: number): GatewayTool[] {
  if (tools.length <= directLimit) return tools;
  return metaTools();
}

export function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

export function searchTools(tools: GatewayTool[], query: string, limit = 8): GatewayTool[] {
  const cap = clampLimit(limit);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) {
    return [...tools].sort((a, b) => a.name.localeCompare(b.name)).slice(0, cap);
  }
  const ranked = tools
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return ranked.slice(0, cap).map((item) => item.tool);
}

function scoreTool(tool: GatewayTool, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term || name.endsWith(`__${term}`)) score += 5;
    else if (name.includes(term)) score += 3;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export function serverIndex(tools: GatewayTool[]): string {
  const names = new Map<string, string>();
  for (const tool of tools) {
    const parsed = splitTool(tool.name);
    if (!parsed || names.has(parsed.slug)) continue;
    const match = tool.description.match(/^\[([^\]]+)\]/);
    names.set(parsed.slug, match?.[1] ?? parsed.slug);
  }
  return [...names.entries()].map(([slug, name]) => `${slug} (${name})`).join(", ");
}

export function formatMatches(tools: GatewayTool[], query: string): string {
  if (tools.length === 0) {
    return "No tools matched. Try the store slug or the action, such as orders or products.";
  }
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
  const heading = terms.length === 0 ? `Showing ${tools.length} tools. Pass a query to narrow them.` : `${tools.length} match.`;
  const body = tools
    .map((tool) => {
      const schema = { ...tool.inputSchema };
      delete schema.$schema;
      return `${tool.name}\n${tool.description}\narguments: ${JSON.stringify(schema)}`;
    })
    .join("\n\n");
  return `${heading}\n\n${body}`;
}

export type ResolvedCall =
  | { kind: "search"; text: string }
  | { kind: "call"; name: string; arguments: Record<string, unknown> }
  | { kind: "direct"; name: string; arguments: Record<string, unknown> }
  | { kind: "error"; message: string };

export function resolveModelCall(catalog: GatewayTool[], name: string, args: Record<string, unknown>): ResolvedCall {
  if (name === SEARCH_TOOL) {
    const query = typeof args.query === "string" ? args.query : "";
    return { kind: "search", text: formatMatches(searchTools(catalog, query, clampLimit(args.limit)), query) };
  }
  if (name === CALL_TOOL) {
    const target = typeof args.name === "string" ? args.name.trim() : "";
    if (!target || target === SEARCH_TOOL || target === CALL_TOOL) {
      return { kind: "error", message: "call_tool needs the name of a store tool, such as woo__list_orders." };
    }
    return { kind: "call", name: target, arguments: objectArgs(args.arguments) };
  }
  return { kind: "direct", name, arguments: args };
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
