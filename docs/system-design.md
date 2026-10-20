# System design and tradeoffs

## Architecture

Four processes, one Helm release, namespace `urumi`.

The store chart runs MariaDB, WordPress, a one-shot bootstrap Job, and `woo-mcp`. The platform chart runs Postgres, the gateway, the dashboard, `notes-mcp`, and `clock-mcp`. An umbrella chart installs both so local and production stay one command with two values files.

`woo-mcp` is the only component that holds the WooCommerce consumer key. It calls the WooCommerce REST API (`/wp-json/wc/v3`) with HTTP basic auth. REST is a normal network call from a separate pod, so the store boundary is a Service plus a NetworkPolicy. WP-CLI runs only in the bootstrap Job, where it installs the plugin, turns on cash on delivery, and inserts the pre-generated API key. WooCommerce stores the consumer key as `hash_hmac('sha256', key, 'wc-api')`, so the Job inserts that hash rather than the raw key.

The gateway is one Node process. It serves the dashboard API, the chat loop, and `POST /mcp`. All three call the same router. Chat does not talk to WooCommerce or to the upstream MCP servers itself.

## Tool aggregation, routing, failure

Upstream tool `list_orders` on server `woo` is exposed as `woo__list_orders`. The slug is the route key. A second server can expose `list_orders` and it becomes `notes__list_orders` or whatever its slug is. The original name stays in the description. Slugs are a single lowercase token, so the first `__` is unambiguous even if an upstream name itself contains `__`.

`tools/list` fans out to every enabled server. Each call has a 3 second timeout. A timeout or a connection error is recorded against that server and the other servers are still returned. `tools/call` has a 20 second timeout and names the upstream in the error. The gateway keeps its own MCP session to each upstream. The caller's session id and bearer token are not forwarded. The upstream credential, if any, is decrypted and attached on the way out.

A probe runs every 15 seconds and sets Connected, Unreachable, or Disabled. Disabled servers are left out of the tool list. Deleting a pod makes the next probe Unreachable without taking the other servers down.

## Sessions and replicas

Downstream MCP requests are stateless. Each `POST /mcp` is handled on its own, and the gateway does not issue an `Mcp-Session-Id`. A client that still sends one is accepted. `GET /mcp` returns 405 because the gateway does not keep a server-push stream. Tool calls are request and response, so a replica restart does not strand a session.

Upstream connections stay in memory on the pod that opened them. Any replica can open its own connection to the same upstream, so a call that lands on the other pod still works. Local and production values run two gateway replicas. The chart default is one.

## Tool catalog

The dashboard chat model never receives the full tool list. It gets `search_tools` and `call_tool`. `search_tools` matches names and descriptions and returns the argument schema. `call_tool` runs the chosen tool through the same permission check as a direct call. A member still cannot create a product or change an order status, including by naming that tool inside `call_tool`.

MCP clients receive every allowed tool while the catalog is at or under `TOOL_DIRECT_LIMIT` (24). Above that, `tools/list` returns only the two catalog tools. A direct `tools/call` by name still works, and it is still rejected when the role is not allowed to use it.

## Rate limits

Each user gets `RATE_LIMIT_PER_MINUTE` requests (default 60) on `POST /mcp` and `POST /api/chat`. The counter is a row in Postgres, so both replicas share the window. The next request in that minute is 429 with `Retry-After: 60`. Set the limit to 0 to turn it off.

## Metrics

`GET /metrics` is Prometheus text for that process: call count, error count, and total duration per server, plus a `urumi_gateway_info` series with the pod name. It is not routed through the public Ingress. The Audit page reads the shared audit log for the last 24 hours, so those totals include every replica.

## What changes for production

`values-prod.yaml` is the only intended diff:

- Ingress hosts and the WordPress site URL become real DNS names. Local uses `sslip.io`, which resolves `store.127.0.0.1.sslip.io` to `127.0.0.1`, so kind's port 80 mapping is enough.
- `storageClass` moves from kind's `standard` to k3s `local-path`.
- Image repositories move from local tags (`urumi-gateway:local`, `pullPolicy: IfNotPresent` after `kind load`) to a registry.
- TLS is a flag on the Ingress plus a secret name. `cookieSecure` is true in the prod file, so turn TLS on before using that file or browsers will drop the session cookie.
- Secrets are not in the prod values. Create `store-secrets` and `platform-secrets` with `kubectl`, with the same keys the chart reads. Local installs instead pass a gitignored `secrets.local.yaml` with `secrets.create: true`.

## Upgrades and rollback

Images are pinned by tag in the values file. A release is `helm upgrade urumi charts/urumi -n urumi -f values-prod.yaml -f secrets.prod.yaml`. Helm keeps the previous release. `helm rollback urumi -n urumi` restores the previous manifests. WordPress and MariaDB use `Recreate` because the volumes are ReadWriteOnce. The bootstrap Job is idempotent: it skips `wp core install`, plugin install, API key insert, and the sample product when they already exist. Take a volume snapshot before a WordPress image bump. Rolling back the chart does not roll back a migration that already wrote to the database.

## Multi-store provisioning

The dashboard Stores page inserts a row and returns immediately. A separate provisioner deployment, using the gateway image plus the Helm binary, polls that table. For each new store it creates namespace `st-{slug}`, a ResourceQuota and LimitRange, then `helm upgrade --install` of `charts/store`. The storefront host is `{slug}.{hostSuffix}`. When the release is ready, the provisioner registers `http://woo-mcp.st-{slug}.svc.cluster.local:8080/mcp` under that slug, so tools are `linen__list_orders` rather than a second `woo__list_orders`.

Several stores run at once, up to three Helm installs in parallel. Each user can own three stores. A store still marked provisioning after 12 minutes is marked failed with a reason, and Retry starts a new attempt. Helm install is safe to run again. If the provisioner pod restarts mid-install, the next poll continues the same release, or marks it failed once the timeout has passed. Delete uninstalls the release, deletes the namespace (which removes volumes and Secrets), and removes the MCP server row.

Each store's NetworkPolicy only allows its own WooCommerce MCP pod to reach its own WordPress Service. MariaDB accepts connections only from WordPress and the bootstrap Job in that namespace. A pod in `st-linen` is not selected by the policies in `st-wool`.

The provisioner is the only workload with a service account token. Its ClusterRole can manage the namespaced resources the store chart installs, not the whole cluster API.

## MCP client sign-in

An external client can still send `Authorization: Bearer urk_...`. It can also use OAuth: the gateway is the authorization server at the dashboard host. `GET /authorize` stores the PKCE request and redirects to `/oauth/consent`. The signed-in user allows or denies it. Allow issues a one-time code, and `POST /token` exchanges that code for an `uro_` access token bound to that user. The token is stored as a hash. The client bearer is still not forwarded to upstream MCP servers.

Local `publicUrl` is `http://`, so the chart sets `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` only in that case. Production `publicUrl` is `https://` and does not set the flag.

## Hosted MCP servers

An admin can register a server with a container image instead of a URL. The image must listen on port 8080, serve `/mcp`, `/healthz`, and `/readyz`, and run as user 1000. The provisioner creates a Deployment, Service, and NetworkPolicy named `hosted-{slug}` in the platform namespace. The gateway calls `http://hosted-{slug}.{namespace}.svc.cluster.local:8080/mcp`. The pod has no service account token. Only the gateway may connect to it, and its egress is DNS plus public HTTPS. Removing the server deletes those objects and the registry row.

## What this does not do yet

A live VPS or k3s install is not part of this repo. `values-prod.yaml` is the template for that host: real DNS, `local-path` storage, registry images, and TLS. cert-manager is not installed.
