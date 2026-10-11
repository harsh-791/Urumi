#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
out="$root/secrets.local.yaml"
if [ -f "$out" ]; then
  echo "$out already exists. Remove it first if you want a new one."
  exit 1
fi
rand() { openssl rand -base64 "$1" | tr -d '\n'; }
woo_token=$(rand 24)
notes_token=$(rand 24)
clock_token=$(rand 24)
openai=${OPENAI_API_KEY:-replace-with-your-openai-key}
cat > "$out" <<EOF
store:
  secrets:
    create: true
    dbPassword: "$(rand 18)"
    dbRootPassword: "$(rand 18)"
    wpAdminPassword: "$(rand 18)"
    wcConsumerKey: "ck_$(openssl rand -hex 20)"
    wcConsumerSecret: "cs_$(openssl rand -hex 20)"
    wooMcpToken: "$woo_token"
platform:
  secrets:
    create: true
    dbPassword: "$(rand 18)"
    adminPassword: "$(rand 18)"
    credentialKey: "$(openssl rand -base64 32 | tr -d '\n')"
    openaiApiKey: "$openai"
    wooMcpToken: "$woo_token"
    notesMcpToken: "$notes_token"
    clockMcpToken: "$clock_token"
EOF
chmod 600 "$out"
echo "Wrote $out"
echo "Dashboard admin email is admin@urumi.local"
echo "Dashboard admin password is platform.secrets.adminPassword in that file."
echo "WordPress admin password is store.secrets.wpAdminPassword."
if [ "$openai" = "replace-with-your-openai-key" ]; then
  echo "Set OPENAI_API_KEY and regenerate, or edit openaiApiKey before deploying."
fi
