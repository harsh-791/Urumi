import { useContext, useEffect, useState } from "react";
import { api, type McpServer } from "../api";
import { UserContext } from "../App";

const empty = {
  slug: "",
  name: "",
  url: "",
  image: "",
  authType: "bearer",
  authHeaderName: "",
  credential: "",
};

export function ServersPage() {
  const user = useContext(UserContext);
  const admin = user?.role === "admin";
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);

  function refresh() {
    api.servers().then((body) => setServers(body.servers)).catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <h1>MCP servers</h1>
      <p className="lede">
        WooCommerce is registered first. Tools from every enabled server are available through one gateway endpoint.
      </p>
      {error && <div className="error">{error}</div>}
      <div className={admin ? "grid-2" : ""}>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Tools</th>
                {admin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td>
                    <strong>{server.name}</strong>
                    <div className="mono">{server.slug}</div>
                    {admin && server.image && <div className="mono">{server.image}</div>}
                    {admin && server.url && <div className="mono">{server.url}</div>}
                    <div>{server.hasCredential ? `Credential stored (${server.authType})` : "No upstream credential"}</div>
                  </td>
                  <td>
                    <span className={`status ${server.status}`}>
                      <i />
                      {server.status}
                    </span>
                    {server.statusDetail && <div className="mono">{server.statusDetail}</div>}
                  </td>
                  <td>
                    <ul className="tools">
                      {server.tools.map((tool) => (
                        <li key={tool.name} className="mono">
                          {tool.name}
                        </li>
                      ))}
                      {server.tools.length === 0 && <li>None listed</li>}
                    </ul>
                  </td>
                  {admin && (
                    <td>
                      <div className="row">
                        <button className="btn quiet" type="button" onClick={() => setEditing(server.id)}>
                          Edit
                        </button>
                        <button
                          className="btn quiet"
                          type="button"
                          onClick={() =>
                            api.updateServer(server.id, { enabled: !server.enabled }).then(refresh).catch((err: Error) => setError(err.message))
                          }
                        >
                          {server.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          className="btn danger"
                          type="button"
                          onClick={() => {
                            if (!window.confirm(`Remove ${server.name}?`)) return;
                            api.deleteServer(server.id).then(refresh).catch((err: Error) => setError(err.message));
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      {editing === server.id && (
                        <EditForm
                          server={server}
                          onDone={() => {
                            setEditing(null);
                            refresh();
                          }}
                          onError={setError}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {admin && (
          <form
            className="card fields"
            onSubmit={(event) => {
              event.preventDefault();
              api
                .createServer(form)
                .then(() => {
                  setForm(empty);
                  refresh();
                })
                .catch((err: Error) => setError(err.message));
            }}
          >
            <strong>Add a server</strong>
            <label>
              Name
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </label>
            <label>
              Slug
              <input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} required />
            </label>
            <label>
              URL
              <input
                value={form.url}
                placeholder="Leave empty when you supply an image"
                onChange={(event) => setForm({ ...form, url: event.target.value })}
              />
            </label>
            <label>
              Image
              <input
                value={form.image}
                placeholder="urumi-clock-mcp:local"
                onChange={(event) => setForm({ ...form, image: event.target.value })}
              />
            </label>
            <label>
              Credential
              <select value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value })}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </select>
            </label>
            {form.authType === "header" && (
              <label>
                Header name
                <input
                  value={form.authHeaderName}
                  onChange={(event) => setForm({ ...form, authHeaderName: event.target.value })}
                />
              </label>
            )}
            {form.authType !== "none" && (
              <label>
                Secret
                <input
                  type="password"
                  value={form.credential}
                  onChange={(event) => setForm({ ...form, credential: event.target.value })}
                />
              </label>
            )}
            <button className="btn" type="submit">
              Register
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function EditForm({
  server,
  onDone,
  onError,
}: {
  server: McpServer;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(server.name);
  const [url, setUrl] = useState(server.url ?? "");
  const [credential, setCredential] = useState("");
  return (
    <form
      className="fields"
      style={{ marginTop: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        api
          .updateServer(server.id, { name, url, credential: credential || undefined })
          .then(onDone)
          .catch((err: Error) => onError(err.message));
      }}
    >
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        URL
        <input value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label>
        Replace credential
        <input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} />
      </label>
      <button className="btn" type="submit">
        Save
      </button>
    </form>
  );
}
