import { readFileSync } from "node:fs";

const API = "https://kubernetes.default.svc";

export async function k8s(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

export async function ensureNamespace(name: string, slug: string): Promise<void> {
  const created = await k8s("POST", "/api/v1/namespaces", {
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/part-of": "urumi",
        "urumi.io/store": slug,
      },
    },
  });
  if (created.status !== 201 && created.status !== 409) {
    throw new Error(`namespace ${name}: ${created.status} ${created.body.slice(0, 300)}`);
  }
}

export async function ensureQuota(namespace: string): Promise<void> {
  const quota = {
    metadata: { name: "store" },
    spec: {
      hard: {
        "requests.cpu": "1",
        "requests.memory": "1Gi",
        "limits.cpu": "4",
        "limits.memory": "3Gi",
        pods: "8",
        persistentvolumeclaims: "4",
        services: "8",
      },
    },
  };
  const limits = {
    metadata: { name: "store" },
    spec: {
      limits: [
        {
          type: "Container",
          default: { cpu: "200m", memory: "256Mi" },
          defaultRequest: { cpu: "50m", memory: "64Mi" },
          max: { cpu: "1", memory: "1Gi" },
        },
      ],
    },
  };
  await apply(namespace, "resourcequotas", quota);
  await apply(namespace, "limitranges", limits);
}

async function apply(namespace: string, collection: string, body: { metadata: { name: string } }): Promise<void> {
  const path = `/api/v1/namespaces/${namespace}/${collection}`;
  const created = await k8s("POST", path, body);
  if (created.status === 201 || created.status === 409) return;
  const replaced = await k8s("PUT", `${path}/${body.metadata.name}`, body);
  if (replaced.status !== 200) {
    throw new Error(`${collection}: ${replaced.status} ${replaced.body.slice(0, 300)}`);
  }
}

export async function deletePendingHelmSecrets(namespace: string): Promise<void> {
  const listed = await k8s(
    "GET",
    `/api/v1/namespaces/${namespace}/secrets?labelSelector=${encodeURIComponent("owner=helm,name=store")}`,
  );
  if (listed.status === 404) return;
  if (listed.status !== 200) return;
  const parsed = JSON.parse(listed.body) as { items?: { metadata?: { name?: string; labels?: { status?: string } } }[] };
  for (const item of parsed.items ?? []) {
    const status = item.metadata?.labels?.status ?? "";
    const name = item.metadata?.name;
    if (!name || !status.startsWith("pending-")) continue;
    await k8s("DELETE", `/api/v1/namespaces/${namespace}/secrets/${name}`);
  }
}

export async function waitForDeployments(namespace: string, names: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await Promise.all(names.map((name) => deploymentReady(namespace, name)));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`store pods did not become ready in ${namespace}`);
}

async function deploymentReady(namespace: string, name: string): Promise<boolean> {
  const got = await k8s("GET", `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
  if (got.status !== 200) return false;
  const body = JSON.parse(got.body) as { status?: { readyReplicas?: number } };
  return (body.status?.readyReplicas ?? 0) >= 1;
}

export async function deleteNamespace(name: string): Promise<void> {
  const result = await k8s("DELETE", `/api/v1/namespaces/${name}`);
  if (result.status !== 200 && result.status !== 202 && result.status !== 404) {
    throw new Error(`delete namespace ${name}: ${result.status} ${result.body.slice(0, 300)}`);
  }
}
