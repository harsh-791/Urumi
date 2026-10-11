import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  return (
    <div className="login-wrap">
      <form
        className="login fields"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          api
            .login(email, password)
            .then(() => navigate("/servers"))
            .catch((err: Error) => setError(err.message));
        }}
      >
        <div>
          <h1>Urumi</h1>
          <p className="lede">Sign in to the team gateway.</p>
        </div>
        {error && <div className="error">{error}</div>}
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button className="btn" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
