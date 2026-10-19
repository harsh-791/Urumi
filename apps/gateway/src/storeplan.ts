export const RESERVED_SLUGS = new Set(["woo", "notes", "clock"]);

export function storeNamespace(slug: string): string {
  return `st-${slug}`;
}

export function storeHost(slug: string, suffix: string): string {
  return `${slug}.${suffix.replace(/^\.+/, "")}`;
}

export function storeUrl(slug: string, suffix: string): string {
  return `http://${storeHost(slug, suffix)}`;
}

export function mcpUrl(namespace: string): string {
  return `http://woo-mcp.${namespace}.svc.cluster.local:8080/mcp`;
}

export function timedOut(started: Date | null, now: Date, timeoutMs: number): boolean {
  if (!started) return false;
  return now.getTime() - started.getTime() > timeoutMs;
}
