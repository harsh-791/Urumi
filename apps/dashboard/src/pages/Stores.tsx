import { useEffect, useState } from "react";
import { api, type Store } from "../api";

export function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");

  function refresh() {
    api.stores().then((body) => setStores(body.stores)).catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <h1>Stores</h1>
      <p className="lede">
        Each store is its own namespace, database, and WooCommerce MCP server. Tools are named after the slug, such as
        linen__list_orders.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="grid-2">
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id}>
                  <td>
                    <div>{store.name}</div>
                    <a href={store.url}>{store.url}</a>
                    {store.statusDetail && <div>{store.statusDetail}</div>}
                  </td>
                  <td>{store.status}</td>
                  <td>{new Date(store.createdAt).toLocaleString()}</td>
                  <td>
                    {store.status === "failed" && (
                      <button className="btn" type="button" onClick={() => api.retryStore(store.id).then(refresh).catch((err: Error) => setError(err.message))}>
                        Retry
                      </button>
                    )}
                    {store.status !== "deleting" && (
                      <button className="btn danger" type="button" onClick={() => api.deleteStore(store.id).then(refresh).catch((err: Error) => setError(err.message))}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form
          className="card fields"
          onSubmit={(event) => {
            event.preventDefault();
            api
              .createStore({ name, slug })
              .then(() => {
                setName("");
                setSlug("");
                refresh();
              })
              .catch((err: Error) => setError(err.message));
          }}
        >
          <strong>New store</strong>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Slug
            <input value={slug} onChange={(event) => setSlug(event.target.value)} required placeholder="linen" />
          </label>
          <button className="btn" type="submit">
            Create store
          </button>
        </form>
      </div>
    </div>
  );
}
