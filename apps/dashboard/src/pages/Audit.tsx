import { useEffect, useState } from "react";
import { api, type AuditEvent } from "../api";

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => {
      api.audit().then((body) => setEvents(body.events)).catch((err: Error) => setError(err.message));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <h1>Audit log</h1>
      <p className="lede">Every tool call through the gateway, including the chat agent, is recorded here.</p>
      {error && <div className="error">{error}</div>}
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
