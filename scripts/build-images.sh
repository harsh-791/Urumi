#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
rm -rf "$root/apps/gateway/chart"
mkdir -p "$root/apps/gateway/chart"
cp -R "$root/charts/store/." "$root/apps/gateway/chart/"
docker build -t urumi-gateway:local "$root/apps/gateway"
rm -rf "$root/apps/gateway/chart"
docker build -t urumi-woo-mcp:local "$root/apps/woo-mcp"
docker build -t urumi-notes-mcp:local "$root/apps/notes-mcp"
docker build -t urumi-clock-mcp:local "$root/apps/clock-mcp"
docker build -t urumi-dashboard:local "$root/apps/dashboard"
if kind get clusters 2>/dev/null | grep -qx urumi; then
  kind load docker-image \
    urumi-gateway:local \
    urumi-woo-mcp:local \
    urumi-notes-mcp:local \
    urumi-clock-mcp:local \
    urumi-dashboard:local \
    --name urumi
fi
