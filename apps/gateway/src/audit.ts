import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export async function writeAudit(entry: {
  userId: string;
  userEmail: string;
  serverSlug: string | null;
  toolName: string;
  startedAt: Date;
  durationMs: number;
  outcome: "success" | "error";
  errorMessage: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log
      (id, user_id, user_email, server_slug, tool_name, started_at, duration_ms, outcome, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      entry.userId,
      entry.userEmail,
      entry.serverSlug,
      entry.toolName,
      entry.startedAt,
      entry.durationMs,
      entry.outcome,
      entry.errorMessage,
    ],
  );
}
