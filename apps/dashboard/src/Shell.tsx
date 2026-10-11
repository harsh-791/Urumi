import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, type User } from "./api";
import { UserContext } from "./App";

export function Shell() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.me().then(setUser).catch(() => navigate("/login"));
  }, [navigate]);

  if (!user) return <div className="main">{error}</div>;

  return (
    <UserContext.Provider value={user}>
      <div className="app">
        <aside className="rail">
          <div className="brand">
            <strong>Urumi</strong>
            <span>Team gateway</span>
          </div>
          <nav>
            <NavLink to="/servers">Servers</NavLink>
            {user.role === "admin" && <NavLink to="/team">Team</NavLink>}
            <NavLink to="/keys">API keys</NavLink>
            <NavLink to="/audit">Audit</NavLink>
            <NavLink to="/chat">Chat</NavLink>
          </nav>
          <div className="who">
            <div>{user.email}</div>
            <div>{user.role}</div>
            <button
              type="button"
              onClick={() => {
                api.logout().then(() => navigate("/login")).catch((err: Error) => setError(err.message));
              }}
            >
              Log out
            </button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </UserContext.Provider>
  );
}
