import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { encryptString } from "./crypto.js";
import { migrate, pool, waitForDb } from "./db.js";
import { deleteNamespace, deletePendingHelmSecrets, ensureNamespace, ensureQuota, waitForDeployments } from "./k8s.js";
import { mcpUrl, timedOut } from "./storeplan.js";

const execFileAsync = promisify(execFile);
const inflight = new Set<string>();
const MAX_PARALLEL = 3;

type StoreTask = {
  id: string;
  slug: string;
  name: string;
  namespace: string;
  url: string;
  status: "provisioning" | "deleting";
  mcp_server_id: string | null;
  attempt_started_at: Date | null;
  created_at: Date;
};

export async function tick(): Promise<void> {
  const result = await pool.query<StoreTask>(
    `SELECT id, slug, name, namespace, url, status, mcp_server_id, attempt_started_at, created_at
     FROM stores WHERE status IN ('provisioning', 'deleting') ORDER BY created_at ASC`,
  );
  const jobs: Promise<void>[] = [];
  for (const store of result.rows) {
    if (inflight.has(store.id)) continue;
    const active = [...inflight].length;
    if (store.status === "provisioning" && active >= MAX_PARALLEL) continue;
    inflight.add(store.id);
    const job = (store.status === "deleting" ? removeStore(store) : provisionStore(store)).finally(() => {
      inflight.delete(store.id);
    });
    jobs.push(job);
  }
  await Promise.all(jobs);
}

async function provisionStore(store: StoreTask): Promise<void> {
  if (timedOut(store.attempt_started_at, new Date(), config.stores.timeoutMs)) {
    await mark(store.id, "failed", "Provisioning timed out. Retry from the dashboard.");
    return;
  }
  if (!store.attempt_started_at) {
    await pool.query(`UPDATE stores SET attempt_started_at = now(), updated_at = now() WHERE id = $1`, [store.id]);
  }
  const dir = await mkdtemp(join(tmpdir(), "store-"));
  const valuesPath = join(dir, "values.json");
  try {
    await ensureNamespace(store.namespace, store.slug);
    await ensureQuota(store.namespace);
    await deletePendingHelmSecrets(store.namespace);
    const secrets = newSecrets();
    await writeFile(valuesPath, JSON.stringify(helmValues(store, secrets)), { mode: 0o600 });
    await helm(["upgrade", "--install", "store", config.stores.chartPath, "--namespace", store.namespace, "--timeout", "10m", "-f", valuesPath]);
    await waitForDeployments(store.namespace, ["mariadb", "wordpress", "woo-mcp"], 2 * 60 * 1000);
    const serverId = await registerServer(store, secrets.wooMcpToken);
    await pool.query(
      `UPDATE stores SET status = 'ready', status_detail = NULL, mcp_server_id = $2, updated_at = now() WHERE id = $1 AND status = 'provisioning'`,
      [store.id, serverId],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`provision ${store.slug} failed: ${message}`);
    await mark(store.id, "failed", message.slice(0, 500));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function removeStore(store: StoreTask): Promise<void> {
  try {
    await helm(["uninstall", "store", "--namespace", store.namespace, "--wait", "--timeout", "3m"], true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`helm uninstall ${store.slug}: ${message}`);
  }
  try {
    await deleteNamespace(store.namespace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await mark(store.id, "failed", message.slice(0, 500));
    return;
  }
  if (store.mcp_server_id) {
    await pool.query("DELETE FROM mcp_servers WHERE id = $1", [store.mcp_server_id]);
  }
  await pool.query("DELETE FROM mcp_servers WHERE slug = $1", [store.slug]);
  await pool.query("DELETE FROM stores WHERE id = $1", [store.id]);
}

async function registerServer(store: StoreTask, token: string): Promise<string> {
  const ciphertext = encryptString(token, config.credentialKey);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mcp_servers (id, slug, name, url, auth_type, credential_ciphertext, enabled, status)
     VALUES ($1, $2, $3, $4, 'bearer', $5, true, 'unknown')
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       url = EXCLUDED.url,
       auth_type = 'bearer',
       credential_ciphertext = EXCLUDED.credential_ciphertext,
       enabled = true,
       updated_at = now()
     RETURNING id`,
    [store.mcp_server_id ?? randomUUID(), store.slug, store.name, mcpUrl(store.namespace), ciphertext],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("MCP registration did not return an id");
  return id;
}

function newSecrets() {
  const token = randomBytes(24).toString("base64url");
  return {
    dbPassword: randomBytes(18).toString("base64url"),
    dbRootPassword: randomBytes(18).toString("base64url"),
    wpAdminPassword: randomBytes(18).toString("base64url"),
    wcConsumerKey: `ck_${randomBytes(16).toString("hex")}`,
    wcConsumerSecret: `cs_${randomBytes(16).toString("hex")}`,
    wooMcpToken: token,
  };
}

function helmValues(store: StoreTask, secrets: ReturnType<typeof newSecrets>) {
  const host = new URL(store.url).host;
  return {
    storageClass: config.stores.storageClass,
    wordpress: { url: store.url, title: store.name },
    wooMcp: { repository: config.stores.wooRepository, tag: config.stores.wooTag, pullPolicy: "IfNotPresent" },
    ingress: {
      className: config.stores.ingressClass,
      host,
      controllerNamespace: config.stores.ingressControllerNamespace,
      controllerLabelKey: config.stores.ingressControllerLabelKey,
      controllerLabelValue: config.stores.ingressControllerLabelValue,
      tls: false,
    },
    networkPolicy: true,
    platformNamespace: config.stores.platformNamespace,
    secrets: { create: true, name: "store-secrets", ...secrets },
  };
}

async function helm(args: string[], missingOk = false): Promise<void> {
  try {
    await execFileAsync("helm", args, {
      timeout: 11 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: "/tmp",
        HELM_CACHE_HOME: "/tmp/helm/cache",
        HELM_CONFIG_HOME: "/tmp/helm/config",
        HELM_DATA_HOME: "/tmp/helm/data",
      },
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim() || message;
    if (missingOk && /not found/i.test(detail)) return;
    throw new Error(detail);
  }
}

async function mark(id: string, status: "failed", detail: string): Promise<void> {
  await pool.query(
    `UPDATE stores SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1 AND status <> 'deleting'`,
    [id, status, detail],
  );
}

async function main(): Promise<void> {
  await waitForDb();
  await migrate();
  console.log("provisioner watching stores");
  const run = () => {
    tick().catch((error) => console.error("provision tick failed", error));
  };
  run();
  const timer = setInterval(run, config.stores.pollMs);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    pool.end().finally(() => process.exit(0));
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("provision.js")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
