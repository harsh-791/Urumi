import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALL_TOOL,
  formatMatches,
  resolveModelCall,
  searchTools,
  SEARCH_TOOL,
  serverIndex,
  toolsForClient,
} from "./catalog.js";
import { recordToolCall, renderMetrics, resetMetrics } from "./metrics.js";
import { rateAllows, rateEpoch } from "./rateplan.js";
import type { GatewayTool } from "./tools.js";

const catalog: GatewayTool[] = [
  {
    name: "linen__list_orders",
    description: "[Linen Annex] List orders\nUpstream tool: list_orders.",
    inputSchema: { type: "object", properties: { after: { type: "string" } } },
  },
  {
    name: "woo__list_orders",
    description: "[WooCommerce] List orders\nUpstream tool: list_orders.",
    inputSchema: { type: "object", properties: { after: { type: "string" } } },
  },
  {
    name: "clock__current_time",
    description: "[Clock] Current time",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "linen__create_product",
    description: "[Linen Annex] Create a product",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
];

test("search prefers the named store and still returns the other store's orders tool", () => {
  const matches = searchTools(catalog, "linen orders", 8).map((tool) => tool.name);
  assert.equal(matches[0], "linen__list_orders");
  assert.ok(matches.includes("woo__list_orders"));
  assert.equal(matches.includes("clock__current_time"), false);
});

test("a large catalog is replaced by search and call", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    name: `store${index}__list_orders`,
    description: "orders",
    inputSchema: { type: "object", properties: {} },
  }));
  assert.deepEqual(
    toolsForClient(many, 24).map((tool) => tool.name),
    [SEARCH_TOOL, CALL_TOOL],
  );
  assert.equal(toolsForClient(catalog, 24).length, catalog.length);
});

test("call_tool extracts the upstream name and arguments", () => {
  const resolved = resolveModelCall(catalog, CALL_TOOL, {
    name: "linen__list_orders",
    arguments: "{\"after\":\"2026-10-20T00:00:00Z\"}",
  });
  assert.deepEqual(resolved, {
    kind: "call",
    name: "linen__list_orders",
    arguments: { after: "2026-10-20T00:00:00Z" },
  });
  const missing = resolveModelCall(catalog, CALL_TOOL, {});
  assert.equal(missing.kind, "error");
});

test("search result text includes the schema", () => {
  const text = formatMatches(searchTools(catalog, "current time"), "current time");
  assert.match(text, /clock__current_time/);
  assert.match(text, /arguments:/);
});

test("server index names each store once", () => {
  assert.equal(serverIndex(catalog), "linen (Linen Annex), woo (WooCommerce), clock (Clock)");
});

test("metrics count calls and duration per server", () => {
  resetMetrics();
  recordToolCall("woo", "success", 12);
  recordToolCall("woo", "error", 4);
  const text = renderMetrics();
  assert.match(text, /urumi_tool_calls_total\{server="woo",outcome="success"\} 1/);
  assert.match(text, /urumi_tool_calls_total\{server="woo",outcome="error"\} 1/);
  assert.match(text, /urumi_tool_call_duration_ms_sum\{server="woo"\} 16/);
  assert.match(text, /urumi_tool_call_duration_ms_count\{server="woo"\} 2/);
});

test("rate window allows up to the limit", () => {
  assert.equal(rateEpoch(60_000), 1);
  assert.equal(rateAllows(60, 60), true);
  assert.equal(rateAllows(61, 60), false);
  assert.equal(rateAllows(1000, 0), true);
});
