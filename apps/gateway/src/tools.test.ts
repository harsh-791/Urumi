import assert from "node:assert/strict";
import { test } from "node:test";
import { collectTools, prefixTool, splitTool, toolAllowed } from "./tools.js";

test("prefixes route back to the same server and tool", () => {
  const name = prefixTool("woo", "list_orders");
  assert.deepEqual(splitTool(name), { slug: "woo", name: "list_orders" });
  assert.equal(splitTool("nope"), null);
});

test("members cannot call WooCommerce writes", () => {
  assert.equal(toolAllowed("member", "woo__list_orders"), true);
  assert.equal(toolAllowed("member", "woo__create_product"), false);
  assert.equal(toolAllowed("member", "woo__update_order_status"), false);
  assert.equal(toolAllowed("member", "linen__create_product"), false);
  assert.equal(toolAllowed("member", "notes__create_note"), true);
  assert.equal(toolAllowed("admin", "woo__create_product"), true);
});

test("a dead upstream does not drop the other servers' tools", async () => {
  const { tools, failures } = await collectTools(
    [
      { slug: "woo", name: "WooCommerce" },
      { slug: "clock", name: "Clock" },
    ],
    async (slug) => {
      if (slug === "woo") return new Promise(() => undefined);
      return [{ name: "current_time", description: "now", inputSchema: { type: "object", properties: {} } }];
    },
    { timeoutMs: 30, allow: () => true },
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["clock__current_time"],
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.slug, "woo");
  assert.match(tools[0]?.description ?? "", /\[Clock\]/);
});
