# Urumi

WooCommerce on Kubernetes, with a team MCP gateway in front of it. An admin registers MCP servers once. Every teammate uses them through one gateway URL, or through the chat agent in the dashboard. Upstream credentials stay on the gateway.

The store, its database, the WooCommerce MCP server, the gateway, and the dashboard all run in the cluster. Local kind and a k3s VPS use the same charts. The difference is [`values-local.yaml`](values-local.yaml) versus [`values-prod.yaml`](values-prod.yaml).

## Layout

| Path | What it is |
| --- | --- |
| `apps/gateway` | Dashboard API, MCP endpoint, chat tool loop, audit log |
| `apps/dashboard` | React UI |
| `apps/woo-mcp` | WooCommerce tools over Streamable HTTP. Talks to the store with the REST API. |
| `apps/notes-mcp` | Team notes, the second upstream |
| `apps/clock-mcp` | Current time, the third upstream |
| `charts/store`, `charts/platform`, `charts/urumi` | Helm charts. The umbrella installs both. |
| `docs/system-design.md` | Routing, failure, and the prod diff |
| `docs/threat-model.md` | Credentials, tokens, and untrusted upstreams |

Three servers are seeded on an empty database: WooCommerce, notes, and clock. Tool names are `slug__tool`, so `woo__list_orders` and a second `list_orders` can both exist.

Members can list and read WooCommerce data. `woo__create_product` and `woo__update_order_status` are hidden from them and rejected if called. Admins can call them. Details are in the threat model.

## Local setup

You need Docker, kind, kubectl, and Helm 3.

```sh
kind version || brew install kind
helm version || brew install helm
chmod +x scripts/*.sh

export OPENAI_API_KEY=sk-...
scripts/gen-secrets.sh
scripts/kind-up.sh
scripts/build-images.sh
scripts/deploy-local.sh
```

`deploy-local.sh` runs `helm dependency update` and installs the umbrella chart into namespace `urumi` with a 15 minute timeout. The bootstrap Job downloads WooCommerce and can take a few minutes. Watch it with:

```sh
kubectl get pods -n urumi
kubectl logs job/woo-bootstrap -n urumi
```

The Job is a Helm hook, so if it fails the release fails. It is safe to run `scripts/deploy-local.sh` again. Install, plugin activation, the REST key, and the sample product are skipped when they already exist.

### URLs

| Surface | URL |
| --- | --- |
| Storefront | http://store.127.0.0.1.sslip.io |
| wp-admin | http://store.127.0.0.1.sslip.io/wp-admin |
| Dashboard | http://app.127.0.0.1.sslip.io |
| MCP endpoint | http://app.127.0.0.1.sslip.io/mcp |

sslip.io resolves the IP embedded in the hostname, so nothing has to be added to `/etc/hosts`. kind publishes port 80 on localhost.

WordPress admin user is `admin`. The password is `store.secrets.wpAdminPassword` in `secrets.local.yaml`. Dashboard admin email is `admin@urumi.local`. The password is `platform.secrets.adminPassword` in that same file.

`woo-mcp`, `notes-mcp`, and `clock-mcp` have no Ingress. Only the gateway's pods can open their Services. See the NetworkPolicies in the charts.

## Place an order

1. Open the storefront. A sample product, Brass lamp, is created by the bootstrap Job if the catalog is empty.
2. Add it to the cart and check out. Cash on delivery is enabled, and guest checkout is on.
3. In wp-admin, open WooCommerce → Orders and confirm the order.

## Chat agent

Sign in to the dashboard as the admin (user A). Open Chat.

1. Ask it to create a product with a name and a price, for example: "Create a product named Linen shirt priced at 36.00."
2. Confirm the product on the storefront.
3. Check out an order for it by hand.
4. Ask: "What orders came in today?" The agent should call `clock__current_time` and then `woo__list_orders`. The tool names are shown under the reply.
5. Open Audit. The calls are under your email.

The model is OpenAI, default `gpt-4o-mini`, set with `platform.openaiModel`. The key is `platform.secrets.openaiApiKey`. If you need a different model, change the value and upgrade.

## External MCP client

Sign in as a second user (user B). An admin creates that account under Team. User B opens API keys and generates a key. It is shown once.

Cursor, or any client that speaks Streamable HTTP:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://app.127.0.0.1.sslip.io/mcp",
      "headers": {
        "Authorization": "Bearer urk_..."
      }
    }
  }
}
```

User B should see tools from every enabled server except the two WooCommerce writes. A prompt that needs two servers: "What orders came in today, and save a one-line note summarizing them?" That uses `woo__list_orders` and `notes__create_note`.

Then, as the admin:

- Revoke user B's key. The next MCP call is unauthorized.
- Disable one server. Its tools disappear from chat and from the external client.
- Delete that server's pod (`kubectl delete pod -n urumi -l app.kubernetes.io/name=woo-mcp`). Clock and notes still answer. The dashboard shows WooCommerce as unreachable until the pod is back.
- Audit shows each of these calls with the right user.

## Production-like VPS

Install k3s, then install ingress-nginx so the ingress class matches local (`nginx`). k3s ships Traefik. You can use it instead if you change `ingress.className`, `controllerNamespace`, and the controller label in `values-prod.yaml`. The NetworkPolicies that allow the ingress controller depend on those labels.

```sh
curl -sfL https://get.k3s.io | sh -
# ingress-nginx: use the cloud or bare-metal manifest from the ingress-nginx docs
```

Build the five images, push them, and set `repository` and `tag` in `values-prod.yaml`. Replace `example.com` with your DNS. Point `store` and `app` at the VPS. Storage class `local-path` is the k3s default.

Create the secrets before installing. The keys match the chart:

```sh
kubectl create namespace urumi
kubectl create secret generic store-secrets -n urumi \
  --from-literal=db-password=... \
  --from-literal=db-root-password=... \
  --from-literal=wp-admin-password=... \
  --from-literal=wc-consumer-key=ck_... \
  --from-literal=wc-consumer-secret=cs_... \
  --from-literal=woo-mcp-token=...
kubectl create secret generic platform-secrets -n urumi \
  --from-literal=db-password=... \
  --from-literal=admin-password=... \
  --from-literal=credential-key="$(openssl rand -base64 32)" \
  --from-literal=openai-api-key=sk-... \
  --from-literal=woo-mcp-token=... \
  --from-literal=notes-mcp-token=... \
  --from-literal=clock-mcp-token=...
```

The two `woo-mcp-token` values must match. `credential-key` must decode to 32 bytes.

For TLS, install cert-manager, point the certificate secrets at `store-tls` and `gateway-tls`, and keep `ingress.tls: true`. `cookieSecure` is already true in the prod file.

```sh
helm dependency update charts/urumi
helm upgrade --install urumi charts/urumi \
  --namespace urumi --create-namespace --timeout 15m \
  -f values-prod.yaml
```

Upgrade and roll back:

```sh
helm upgrade urumi charts/urumi -n urumi -f values-prod.yaml
helm history urumi -n urumi
helm rollback urumi -n urumi
```

Do not commit secret values. `values-prod.yaml` only names hosts, storage, images, and secret objects.

## Tests

```sh
npm test --prefix apps/gateway
npm run build
```

Gateway tests cover password hashing, credential encryption, the SSRF rules, tool prefixes, the member write restriction, and a listing where one upstream hangs.

## Beyond the core

Implemented and where to look:

- Role limits on WooCommerce writes: `apps/gateway/src/tools.ts` (`toolAllowed`)
- SSRF checks on admin URLs: `apps/gateway/src/ssrf.ts`
- NetworkPolicies, non-root app containers, no service-account tokens: the chart templates
- Upstream credentials encrypted at rest: `apps/gateway/src/crypto.ts`
- Prod values, TLS flags, and rollback notes: `values-prod.yaml` and `docs/system-design.md`
- Multi-store provisioning: dashboard **Stores**, provisioner in `charts/platform/templates/provisioner.yaml`, reconcile loop in `apps/gateway/src/provision.ts`. See the system design note.

Not implemented: OAuth, hosted MCP servers from an image, multiple gateway replicas, and a tool-search layer. The session limit is described in the design note.
