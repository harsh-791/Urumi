#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"
if [ ! -f secrets.local.yaml ]; then
  echo "Missing secrets.local.yaml. Run scripts/gen-secrets.sh first."
  exit 1
fi
helm dependency update charts/urumi
helm upgrade --install urumi charts/urumi \
  --namespace urumi \
  --create-namespace \
  --timeout 15m \
  -f values-local.yaml \
  -f secrets.local.yaml \
  "$@"
echo "Store:      http://store.127.0.0.1.sslip.io"
echo "Dashboard:  http://app.127.0.0.1.sslip.io"
echo "MCP:        http://app.127.0.0.1.sslip.io/mcp"
