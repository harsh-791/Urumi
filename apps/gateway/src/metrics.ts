type Bucket = { success: number; error: number; durationMs: number };

const buckets = new Map<string, Bucket>();

export function recordToolCall(server: string, outcome: "success" | "error", durationMs: number): void {
  const key = server || "gateway";
  const bucket = buckets.get(key) ?? { success: 0, error: 0, durationMs: 0 };
  if (outcome === "success") bucket.success += 1;
  else bucket.error += 1;
  bucket.durationMs += Math.max(0, durationMs);
  buckets.set(key, bucket);
}

export function resetMetrics(): void {
  buckets.clear();
}

export function renderMetrics(): string {
  const lines = [
    "# HELP urumi_tool_calls_total Tool calls handled by this gateway process.",
    "# TYPE urumi_tool_calls_total counter",
  ];
  const names = [...buckets.keys()].sort();
  for (const server of names) {
    const bucket = buckets.get(server)!;
    lines.push(`urumi_tool_calls_total{server="${label(server)}",outcome="success"} ${bucket.success}`);
    lines.push(`urumi_tool_calls_total{server="${label(server)}",outcome="error"} ${bucket.error}`);
  }
  lines.push("# HELP urumi_tool_call_duration_ms_sum Total tool-call duration in milliseconds for this process.");
  lines.push("# TYPE urumi_tool_call_duration_ms_sum counter");
  for (const server of names) {
    const bucket = buckets.get(server)!;
    lines.push(`urumi_tool_call_duration_ms_sum{server="${label(server)}"} ${bucket.durationMs}`);
  }
  lines.push("# HELP urumi_tool_call_duration_ms_count Tool calls included in the duration sum.");
  lines.push("# TYPE urumi_tool_call_duration_ms_count counter");
  for (const server of names) {
    const bucket = buckets.get(server)!;
    lines.push(`urumi_tool_call_duration_ms_count{server="${label(server)}"} ${bucket.success + bucket.error}`);
  }
  const pod = process.env.HOSTNAME || "local";
  lines.push("# HELP urumi_gateway_info Gateway process identity. One series per replica.");
  lines.push("# TYPE urumi_gateway_info gauge");
  lines.push(`urumi_gateway_info{pod="${label(pod)}"} 1`);
  return `${lines.join("\n")}\n`;
}

function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}
