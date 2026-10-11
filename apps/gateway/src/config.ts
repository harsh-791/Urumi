function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function keyFromBase64(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return key;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  pg: {
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "urumi",
    password: required("PGPASSWORD"),
    database: process.env.PGDATABASE ?? "urumi",
  },
  credentialKey: keyFromBase64(required("CREDENTIAL_ENCRYPTION_KEY")),
  adminEmail: required("ADMIN_EMAIL").toLowerCase(),
  adminPassword: required("ADMIN_PASSWORD"),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  allowClusterUrls: process.env.ALLOW_CLUSTER_URLS !== "false",
  listTimeoutMs: Number(process.env.LIST_TIMEOUT_MS ?? 3000),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_MS ?? 20000),
  probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS ?? 15000),
  seed: {
    wooUrl: process.env.WOO_MCP_URL ?? "",
    wooToken: process.env.WOO_MCP_TOKEN ?? "",
    notesUrl: process.env.NOTES_MCP_URL ?? "",
    notesToken: process.env.NOTES_MCP_TOKEN ?? "",
    clockUrl: process.env.CLOCK_MCP_URL ?? "",
    clockToken: process.env.CLOCK_MCP_TOKEN ?? "",
  },
};
