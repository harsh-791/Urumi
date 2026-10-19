import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export function ConsentPage() {
  const navigate = useNavigate();
  const requestId = new URLSearchParams(window.location.search).get("request") ?? "";
  const [clientName, setClientName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
    api
      .me()
      .then(() => api.oauthRequest(requestId))
      .then((body) => setClientName(body.clientName))
      .catch((err: Error) => {
        if (/login required/i.test(err.message) || /401/.test(err.message)) {
          navigate(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setError(err.message);
      });
  }, [navigate, requestId]);

  function decide(allow: boolean) {
    setBusy(true);
    setError("");
    api
      .oauthDecision(requestId, allow)
      .then((body) => {
        window.location.assign(body.redirect);
      })
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  }

  return (
    <div className="login-wrap">
      <div className="login fields">
        <div>
          <h1>Allow access</h1>
          <p className="lede">
            {clientName ? `${clientName} wants to use the Urumi gateway as you.` : "Checking this sign-in request."}
          </p>
        </div>
        {error && <div className="error">{error}</div>}
        <button className="btn" type="button" disabled={busy || !clientName} onClick={() => decide(true)}>
          Allow
        </button>
        <button className="btn danger" type="button" disabled={busy || !clientName} onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
