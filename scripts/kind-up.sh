#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
if kind get clusters | grep -qx urumi; then
  echo "kind cluster urumi already exists"
else
  kind create cluster --config "$root/deploy/kind-config.yaml"
fi
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/kind/deploy.yaml
kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx --timeout=180s
echo "Cluster is up. Ingress is on localhost:80."
