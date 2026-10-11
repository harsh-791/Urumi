import { useEffect, useState } from "react";
import { api, type ApiKey } from "../api";

export function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState("cursor");
  const [plaintext, setPlaintext] = useState("");
  const [error, setError] = useState("");

  function refresh() {
    api.keys().then((body) => setKeys(body.keys)).catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div>
      <h1>API keys</h1>
      <p className="lede">
        Put the gateway URL and this key in Cursor or Claude Code. The key is shown once. Upstream credentials never leave the gateway.
      </p>
      {error && <div className="error">{error}</div>}
      {plaintext && (
        <div className="secret">
          Copy this key now. It will not be shown again.
          <div className="mono">{plaintext}</div>
        </div>
      )}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          api
            .createKey({ label })
            .then((created) => {
              setPlaintext(created.plaintext);
              refresh();
            })
            .catch((err: Error) => setError(err.message));
        }}
      >
        <label>
          Label
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <button className="btn" type="submit">
          Generate key
        </button>
      </form>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>User</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <div className="mono">{key.key_prefix}…</div>
                  <div>{key.label || "Untitled"}</div>
                  {key.revoked_at && <div>Revoked</div>}
                </td>
                <td>{key.user_email}</td>
                <td>{new Date(key.created_at).toLocaleString()}</td>
                <td>
                  {!key.revoked_at && (
                    <button
                      className="btn danger"
                      type="button"
                      onClick={() => api.revokeKey(key.id).then(refresh).catch((err: Error) => setError(err.message))}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
