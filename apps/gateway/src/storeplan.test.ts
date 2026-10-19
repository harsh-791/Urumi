import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpUrl, storeHost, storeNamespace, storeUrl, timedOut } from "./storeplan.js";

test("a store gets its own namespace, host, and mcp address", () => {
  assert.equal(storeNamespace("linen"), "st-linen");
  assert.equal(storeHost("linen", "127.0.0.1.sslip.io"), "linen.127.0.0.1.sslip.io");
  assert.equal(storeUrl("linen", "127.0.0.1.sslip.io"), "http://linen.127.0.0.1.sslip.io");
  assert.equal(mcpUrl("st-linen"), "http://woo-mcp.st-linen.svc.cluster.local:8080/mcp");
});

test("provisioning times out from the attempt start", () => {
  const start = new Date("2026-10-15T00:00:00Z");
  assert.equal(timedOut(null, start, 1000), false);
  assert.equal(timedOut(start, new Date("2026-10-15T00:00:30Z"), 60_000), false);
  assert.equal(timedOut(start, new Date("2026-10-15T00:02:00Z"), 60_000), true);
});
