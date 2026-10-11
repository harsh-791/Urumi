import { useContext, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, type Role, type User } from "../api";
import { UserContext } from "../App";

export function TeamPage() {
  const me = useContext(UserContext);
  const [users, setUsers] = useState<User[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState("");

  function refresh() {
    api.users().then((body) => setUsers(body.users)).catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    if (me?.role === "admin") refresh();
  }, [me]);

  if (me && me.role !== "admin") return <Navigate to="/servers" replace />;

  return (
    <div>
      <h1>Team</h1>
      <p className="lede">Invite someone, then they sign in and generate their own gateway key.</p>
      {error && <div className="error">{error}</div>}
      <div className="grid-2">
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.role}</td>
                  <td>
                    {user.id !== me?.id && (
                      <button
                        className="btn danger"
                        type="button"
                        onClick={() => api.deleteUser(user.id).then(refresh).catch((err: Error) => setError(err.message))}
                      >
                        Remove
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
              .createUser({ email, password, role })
              .then(() => {
                setEmail("");
                setPassword("");
                refresh();
              })
              .catch((err: Error) => setError(err.message));
          }}
        >
          <strong>Invite</strong>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Temporary password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="btn" type="submit">
            Create account
          </button>
        </form>
      </div>
    </div>
  );
}
