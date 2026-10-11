import assert from "node:assert/strict";
import { test } from "node:test";
import { assertUrlAllowed, SsrfError, type DnsLookup } from "./ssrf.js";

const lookup: DnsLookup = async (hostname) => {
  const table: Record<string, string> = {
    "woo-mcp.urumi.svc.cluster.local": "10.43.1.8",
    "evil.example": "169.254.169.254",
    "shop.example": "93.184.216.34",
    "rebind.example": "10.1.2.3",
  };
  const address = table[hostname];
  if (!address) throw new Error(`unmapped ${hostname}`);
  return [{ address, family: 4 }];
};

const allow = { allowClusterUrls: true, lookup };

test("allows in-cluster service DNS over http", async () => {
  const url = await assertUrlAllowed("http://woo-mcp.urumi.svc.cluster.local:8080/mcp", allow);
  assert.equal(url.hostname, "woo-mcp.urumi.svc.cluster.local");
});

test("blocks metadata, loopback, and private rebinding", async () => {
  await assert.rejects(() => assertUrlAllowed("http://169.254.169.254/latest", allow), SsrfError);
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1:8080/mcp", allow), SsrfError);
  await assert.rejects(() => assertUrlAllowed("https://evil.example/mcp", allow), SsrfError);
  await assert.rejects(() => assertUrlAllowed("https://rebind.example/mcp", allow), SsrfError);
  await assert.rejects(() => assertUrlAllowed("http://shop.example/mcp", allow), SsrfError);
});

test("allows a public https host", async () => {
  const url = await assertUrlAllowed("https://shop.example/mcp", allow);
  assert.equal(url.protocol, "https:");
});

test("blocks cluster DNS when the operator disables it", async () => {
  await assert.rejects(
    () => assertUrlAllowed("http://woo-mcp.urumi.svc.cluster.local/mcp", { allowClusterUrls: false, lookup }),
    SsrfError,
  );
});
