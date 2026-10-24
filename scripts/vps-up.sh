#!/bin/sh
# Install k3s, ingress-nginx, and the Urumi chart on a Linux VPS.
# Run it on the VPS, from a clone of this repo, as root:
#   sudo ./scripts/vps-up.sh
# Edit values-prod.yaml first: real hostnames, and image repositories that are not ghcr.io/OWNER.
# Optional TLS: WITH_CERT_MANAGER=1 sudo ./scripts/vps-up.sh
# Then set ingress.certManagerIssuer to letsencrypt-prod and run the script again.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"

if [ "$(uname -s)" != "Linux" ]; then
  echo "Run this on the VPS, not on $(uname -s)."
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root. sudo ./scripts/vps-up.sh"
  exit 1
fi

if grep -q 'example.com' values-prod.yaml; then
  echo "values-prod.yaml still uses example.com. Set the store host, the dashboard host, and the store host suffix."
  exit 1
fi
if grep -q 'ghcr.io/OWNER' values-prod.yaml; then
  echo "values-prod.yaml still uses ghcr.io/OWNER. Push the images and set repository and tag."
  exit 1
fi

if ! command -v k3s >/dev/null 2>&1; then
  curl -sfL https://get.k3s.io | sh -s - --disable=traefik
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

if ! command -v helm >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

if ! kubectl get ingressclass nginx >/dev/null 2>&1; then
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml
  kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx --timeout=180s
fi

if [ "${WITH_CERT_MANAGER:-}" = "1" ]; then
  if ! kubectl get namespace cert-manager >/dev/null 2>&1; then
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
    kubectl rollout status deployment/cert-manager -n cert-manager --timeout=180s
    kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=180s
  fi
  kubectl apply -f deploy/letsencrypt-issuer.yaml
fi

secrets="$root/secrets.prod.yaml"
if [ ! -f "$secrets" ]; then
  echo "Missing secrets.prod.yaml. Generate it on this machine with scripts/gen-secrets.sh,"
  echo "then copy the result to secrets.prod.yaml and set the OpenAI key. The file is gitignored."
  exit 1
fi

helm dependency update charts/urumi
helm upgrade --install urumi charts/urumi \
  --namespace urumi \
  --create-namespace \
  --timeout 15m \
  -f values-prod.yaml \
  -f secrets.prod.yaml

echo "Helm release urumi is installed."
echo "Point store and app DNS at this host, then open the hosts in values-prod.yaml."
