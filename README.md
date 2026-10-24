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

The same URL also accepts OAuth. Leave the header off and let the client discover `/.well-known/oauth-protected-resource/mcp`. It redirects to the dashboard, you sign in, and Allow issues a token for that user. API keys keep working.

Then, as the admin:

- Revoke user B's key. The next MCP call is unauthorized.
- Disable one server. Its tools disappear from chat and from the external client.
- Delete that server's pod (`kubectl delete pod -n urumi -l app.kubernetes.io/name=woo-mcp`). Clock and notes still answer. The dashboard shows WooCommerce as unreachable until the pod is back.
- Audit shows each of these calls with the right user.

## Production-like VPS

`values-prod.yaml` is the only diff from local:

| | Local | VPS |
| --- | --- | --- |
| Hosts | `*.127.0.0.1.sslip.io` | Your DNS, `store` and `app` |
| Storage | kind `standard` | k3s `local-path` |
| Images | `urumi-*:local`, loaded into kind | A registry, tag `0.1.0` |
| TLS | Off, `cookieSecure: false` | On, `cookieSecure: true` |
| Secrets | gitignored `secrets.local.yaml` | gitignored `secrets.prod.yaml`, or Secrets created with kubectl |

k3s ships Traefik. `scripts/vps-up.sh` installs k3s with Traefik disabled and installs ingress-nginx, because the NetworkPolicies allow that controller by namespace and label. Run it on the VPS as root, after the hosts and image names in `values-prod.yaml` are real:

```sh
sudo ./scripts/vps-up.sh
```

`WITH_CERT_MANAGER=1 sudo ./scripts/vps-up.sh` also installs cert-manager and `deploy/letsencrypt-issuer.yaml`. Set the email in that file, set `ingress.certManagerIssuer: letsencrypt-prod` on the store and the platform, and run the script again. The ingress annotation asks cert-manager for the certificate. Leave the issuer empty until DNS points at the VPS.

Build the five images, push them, and set `repository` and `tag` in `values-prod.yaml`. Point `store` and `app` at the VPS.

On the VPS, generate the gitignored secrets file, then copy it into place. The two WooCommerce MCP tokens in that file match. The credential key decodes to 32 bytes.

```sh
OPENAI_API_KEY=sk-... ./scripts/gen-secrets.sh
cp secrets.local.yaml secrets.prod.yaml
```

`vps-up.sh` installs from `values-prod.yaml` and `secrets.prod.yaml`. To create the Secrets with kubectl instead, leave `secrets.create` false and do not pass the secrets file. The Secret names are `store-secrets` and `platform-secrets`, with the keys `db-password`, `db-root-password`, `wp-admin-password`, `wc-consumer-key`, `wc-consumer-secret`, `woo-mcp-token`, `admin-password`, `credential-key`, `openai-api-key`, `notes-mcp-token`, and `clock-mcp-token`.

Upgrade and roll back:

```sh
helm upgrade urumi charts/urumi -n urumi -f values-prod.yaml
helm history urumi -n urumi
helm rollback urumi -n urumi
```

On the local cluster this was run for real: revision 19 raised the gateway rate limit to 30, `helm rollback urumi 18` restored 60, and the storefront stayed up. The design note has the pod checks. Pin image tags in the registry when the rollback must restore an older binary. The local tags are all `:local`.

Do not commit secret values. `values-prod.yaml` only names hosts, storage, images, and secret objects.

## Tests

```sh
npm test --prefix apps/gateway
npm run build
```

Gateway tests cover password hashing, credential encryption, the SSRF rules, tool prefixes, the member write restriction, a listing where one upstream hangs, tool search, the catalog switch, and the rate-limit window.

## Beyond the core

Implemented and where to look:

- Role limits on WooCommerce writes: `apps/gateway/src/tools.ts` (`toolAllowed`)
- SSRF checks on admin URLs: `apps/gateway/src/ssrf.ts`
- NetworkPolicies, non-root app containers, no service-account tokens: the chart templates
- Upstream credentials encrypted at rest: `apps/gateway/src/crypto.ts`
- Prod values, TLS flags, and rollback notes: `values-prod.yaml` and `docs/system-design.md`
- Multi-store provisioning: dashboard **Stores**, provisioner in `charts/platform/templates/provisioner.yaml`, reconcile loop in `apps/gateway/src/provision.ts`. See the system design note.
- OAuth for MCP clients: `apps/gateway/src/oauth.ts` and the dashboard consent page at `/oauth/consent`. API keys still work.
- Hosted MCP servers: on **Servers**, leave the URL empty and set an image such as `urumi-clock-mcp:local`. The provisioner runs it. See `apps/gateway/src/hosted.ts`.
- Tool catalog: dashboard chat searches with `search_tools` and runs one tool with `call_tool` (`apps/gateway/src/catalog.ts`). MCP clients still receive the full list until it passes 24 tools.
- Two gateway replicas, with stateless MCP so a call can land on either pod: `gateway.replicas` in the values files.
- Per-user rate limit, shared in Postgres: `RATE_LIMIT_PER_MINUTE`, default 60.
- Call count, error rate, and average latency per server: the Audit page, and `GET /metrics` on a gateway pod.

Not implemented: a live VPS install. `values-prod.yaml` is the template for that.
