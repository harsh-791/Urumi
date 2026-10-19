import { useState } from "react";
import { api, type ChatToolTrace } from "../api";

type Turn = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolTrace[];
};

function plainReply(text: string): string {
  return text
    .replace(/\s+---\s+/g, "\n\n")
    .replace(/\s+#{1,6}\s+/g, "\n\n")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\s+(\d+\.\s+)/g, "\n$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function send() {
    const content = draft.trim();
    if (!content || busy) return;
    const next = [...turns, { role: "user" as const, content }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError("");
    api
      .chat(next.map(({ role, content: text }) => ({ role, content: text })))
      .then((result) => {
        setTurns([...next, { role: "assistant", content: result.message, toolCalls: result.toolCalls }]);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <div>
      <h1>Chat</h1>
      <p className="lede">The agent calls tools as you. Those calls show up in the audit log under your account.</p>
      {error && <div className="error">{error}</div>}
      <div className="chat-log">
        {turns.map((turn, index) => (
          <div key={index} className={`bubble ${turn.role}`}>
            <div className="reply">{turn.role === "assistant" ? plainReply(turn.content) : turn.content}</div>
            {turn.toolCalls && turn.toolCalls.length > 0 && (
              <div className="trace">
                {turn.toolCalls.map((call, callIndex) => (
                  <span key={`${call.name}-${callIndex}`}>
                    {call.ok ? "called" : "failed"} {call.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          placeholder="Create a product, or ask what orders came in today."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Working" : "Send"}
        </button>
      </form>
    </div>
  );
}
