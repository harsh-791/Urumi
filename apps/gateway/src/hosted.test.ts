import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedName, hostedUrl, validImage } from "./hostedplan.js";

test("an image reference needs a tag or digest and cannot be a URL", () => {
  assert.equal(validImage("urumi-clock-mcp:local"), true);
  assert.equal(validImage("ghcr.io/acme/clock:1.2.3"), true);
  assert.equal(validImage("ghcr.io/acme/clock@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(validImage("http://example.com/clock:local"), false);
  assert.equal(validImage("clock"), false);
  assert.equal(validImage("clock:"), false);
  assert.equal(validImage("has space:tag"), false);
});

test("a hosted server gets a cluster address from its slug", () => {
  assert.equal(hostedName("desk"), "hosted-desk");
  assert.equal(hostedUrl("desk", "urumi"), "http://hosted-desk.urumi.svc.cluster.local:8080/mcp");
});
