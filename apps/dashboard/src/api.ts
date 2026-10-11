export type Role = "admin" | "member";

export type User = { id: string; email: string; role: Role };

export type ServerTool = { name: string; description: string };

export type McpServer = {
  id: string;
  slug: string;
  name: string;
  url?: string;
  authType: "none" | "bearer" | "header";
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  tools: ServerTool[];
};

export type ApiKey = {
  id: string;
  key_prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  user_email: string;
  user_id: string;
};

export type AuditEvent = {
  id: string;
  user_email: string;
  server_slug: string | null;
  tool_name: string;
  started_at: string;
  duration_ms: number;
  outcome: "success" | "error";
  error_message: string | null;
};

export type ChatToolTrace = { name: string; ok: boolean; preview: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  me: () => request<User>("/api/me"),
  login: (email: string, password: string) =>
    request<User>("/api/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),
  servers: () => request<{ servers: McpServer[] }>("/api/servers"),
  createServer: (input: Record<string, unknown>) =>
    request("/api/servers", { method: "POST", body: JSON.stringify(input) }),
  updateServer: (id: string, input: Record<string, unknown>) =>
    request(`/api/servers/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteServer: (id: string) => request(`/api/servers/${id}`, { method: "DELETE" }),
  users: () => request<{ users: User[] }>("/api/users"),
  createUser: (input: { email: string; password: string; role: Role }) =>
    request("/api/users", { method: "POST", body: JSON.stringify(input) }),
  deleteUser: (id: string) => request(`/api/users/${id}`, { method: "DELETE" }),
  keys: () => request<{ keys: ApiKey[] }>("/api/keys"),
  createKey: (input: { label?: string; userId?: string }) =>
    request<{ id: string; prefix: string; plaintext: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeKey: (id: string) => request(`/api/keys/${id}/revoke`, { method: "POST" }),
  audit: () => request<{ events: AuditEvent[] }>("/api/audit"),
  chat: (messages: { role: "user" | "assistant"; content: string }[]) =>
    request<{ message: string; toolCalls: ChatToolTrace[] }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),
};
