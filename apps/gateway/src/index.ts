import express from "express";
import {
  chat,
  createKey,
  createServer,
  createUser,
  deleteServer,
  deleteUser,
  listAudit,
  listKeys,
  listServers,
  listUsers,
  loadSession,
  login,
  logout,
  me,
  revokeKey,
  seedAdmin,
  seedServers,
  updateServer,
} from "./api.js";
import { createStore, deleteStore, listStores, retryStore } from "./stores.js";
import { config } from "./config.js";
import { migrate, pool, waitForDb } from "./db.js";
import { HttpError } from "./errors.js";
import { closeMcpSessions, handleMcp } from "./mcp.js";
import { closeUpstreams, probeServers } from "./upstream.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(loadSession);

function route(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.post("/api/login", route(login));
app.post("/api/logout", route(logout));
app.get("/api/me", route(me));
app.get("/api/servers", route(listServers));
app.post("/api/servers", route(createServer));
app.patch("/api/servers/:id", route(updateServer));
app.delete("/api/servers/:id", route(deleteServer));
app.get("/api/users", route(listUsers));
app.post("/api/users", route(createUser));
app.delete("/api/users/:id", route(deleteUser));
app.get("/api/keys", route(listKeys));
app.post("/api/keys", route(createKey));
app.post("/api/keys/:id/revoke", route(revokeKey));
app.get("/api/audit", route(listAudit));
app.get("/api/stores", route(listStores));
app.post("/api/stores", route(createStore));
app.post("/api/stores/:id/retry", route(retryStore));
app.delete("/api/stores/:id", route(deleteStore));
app.post("/api/chat", route(chat));

app.post("/mcp", (req, res, next) => {
  handleMcp(req, res).catch(next);
});
app.get("/mcp", (req, res, next) => {
  handleMcp(req, res).catch(next);
});
app.delete("/mcp", (req, res, next) => {
  handleMcp(req, res).catch(next);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal error" });
});

let probeTimer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  await waitForDb();
  await migrate();
  await seedAdmin();
  await seedServers();
  const server = app.listen(config.port, () => {
    console.log(`gateway listening on ${config.port}`);
  });
  void probeServers();
  probeTimer = setInterval(() => {
    probeServers().catch((error) => console.error("probe failed", error));
  }, config.probeIntervalMs);

  const shutdown = async () => {
    if (probeTimer) clearInterval(probeTimer);
    server.close();
    await closeMcpSessions();
    await closeUpstreams();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
