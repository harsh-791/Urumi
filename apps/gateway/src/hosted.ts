import { config } from "./config.js";
import { pool } from "./db.js";
import { hostedName, hostedUrl } from "./hostedplan.js";
import { deleteResource, deploymentReady, upsertResource } from "./k8s.js";

function hostedNamespace(): string {
  return config.stores.platformNamespace || "urumi";
}

type HostedRow = { id: string; slug: string; image: string; host_state: string };

export async function reconcileHosted(): Promise<void> {
  const result = await pool.query<HostedRow>(
    `SELECT id, slug, image, host_state FROM mcp_servers
     WHERE image IS NOT NULL AND host_state IN ('pending', 'deleting')
     ORDER BY created_at ASC`,
  );
  for (const row of result.rows) {
    try {
      if (row.host_state === "deleting") await removeHosted(row);
      else await ensureHosted(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`hosted ${row.slug}: ${message}`);
      if (row.host_state === "pending") {
        await pool.query(
          `UPDATE mcp_servers SET status = 'unreachable', status_detail = $2, updated_at = now() WHERE id = $1 AND host_state = 'pending'`,
          [row.id, message.slice(0, 500)],
        );
      }
    }
  }
}

async function ensureHosted(row: HostedRow): Promise<void> {
  const namespace = hostedNamespace();
  const name = hostedName(row.slug);
  await upsertResource("/api/v1", namespace, "services", service(name, row.slug));
  await upsertResource("/apis/apps/v1", namespace, "deployments", deployment(name, row.slug, row.image));
  await upsertResource("/apis/networking.k8s.io/v1", namespace, "networkpolicies", policy(name, row.slug));
  if (!(await deploymentReady(namespace, name))) return;
  await pool.query(
    `UPDATE mcp_servers SET host_state = 'ready', status = 'unknown', status_detail = NULL, updated_at = now()
     WHERE id = $1 AND host_state = 'pending'`,
    [row.id],
  );
}

async function removeHosted(row: HostedRow): Promise<void> {
  const namespace = hostedNamespace();
  const name = hostedName(row.slug);
  await deleteResource("/apis/apps/v1", namespace, "deployments", name);
  await deleteResource("/api/v1", namespace, "services", name);
  await deleteResource("/apis/networking.k8s.io/v1", namespace, "networkpolicies", name);
  await pool.query("DELETE FROM mcp_servers WHERE id = $1 AND host_state = 'deleting'", [row.id]);
}

function labels(slug: string) {
  return {
    "app.kubernetes.io/name": "hosted-mcp",
    "app.kubernetes.io/part-of": "urumi",
    "urumi.io/hosted": slug,
  };
}

function service(name: string, slug: string) {
  return {
    metadata: { name, labels: labels(slug) },
    spec: {
      selector: { "urumi.io/hosted": slug },
      ports: [{ name: "http", port: 8080, targetPort: "http" }],
    },
  };
}

function deployment(name: string, slug: string, image: string) {
  return {
    metadata: { name, labels: labels(slug) },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "urumi.io/hosted": slug } },
      template: {
        metadata: { labels: labels(slug) },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "mcp",
              image,
              imagePullPolicy: config.hostedPullPolicy,
              ports: [{ name: "http", containerPort: 8080 }],
              env: [{ name: "PORT", value: "8080" }],
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              readinessProbe: { httpGet: { path: "/readyz", port: "http" }, periodSeconds: 10 },
              livenessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 20 },
              resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { cpu: "200m", memory: "128Mi" } },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

function policy(name: string, slug: string) {
  return {
    metadata: { name, labels: labels(slug) },
    spec: {
      podSelector: { matchLabels: { "urumi.io/hosted": slug } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "gateway" } } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        {
          to: [
            {
              ipBlock: {
                cidr: "0.0.0.0/0",
                except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ],
    },
  };
}
