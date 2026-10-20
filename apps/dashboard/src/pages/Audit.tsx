import { useEffect, useState } from "react";
import { api, type AuditEvent, type ServerMetric } from "../api";

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [metrics, setMetrics] = useState<ServerMetric[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => {
      api.audit().then((body) => setEvents(body.events)).catch((err: Error) => setError(err.message));
      api.metrics().then((body) => setMetrics(body.servers)).catch((err: Error) => setError(err.message));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="stack">
      <h1>Audit log</h1>
      <p className="lede">
        Every tool call through the gateway, including the chat agent, is recorded here. The totals cover the last 24
        hours on every gateway replica.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Calls</th>
              <th>Errors</th>
              <th>Error rate</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {metrics.length === 0 && (
              <tr>
                <td colSpan={5}>No tool calls in the last 24 hours.</td>
              </tr>
            )}
            {metrics.map((row) => (
              <tr key={row.server}>
                <td className="mono">{row.server}</td>
                <td>{row.calls}</td>
                <td>{row.errors}</td>
                <td>{row.calls === 0 ? "0%" : `${Math.round((row.errors / row.calls) * 100)}%`}</td>
                <td>{row.avgMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Server</th>
              <th>Tool</th>
              <th>Duration</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.started_at).toLocaleString()}</td>
                <td>{event.user_email}</td>
                <td className="mono">{event.server_slug ?? "—"}</td>
                <td className="mono">{event.tool_name}</td>
                <td>{event.duration_ms} ms</td>
                <td>
                  <span className={`status ${event.outcome === "success" ? "connected" : "error"}`}>
                    <i />
                    {event.outcome}
                  </span>
                  {event.error_message && <div className="mono">{event.error_message}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
