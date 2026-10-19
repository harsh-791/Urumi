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

Downstream MCP sessions live in memory on the gateway, keyed by `Mcp-Session-Id`. The core runs one gateway replica. A second replica would need sticky sessions or a shared session store, because a session created on one process is unknown to the other. That is a deliberate limit, not an accident.

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

## What this does not do yet

Deploying an MCP server from a container image, more than one gateway replica, and a tool-search layer are not built.
