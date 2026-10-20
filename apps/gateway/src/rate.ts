import { pool } from "./db.js";
import { rateAllows, rateEpoch } from "./rateplan.js";

export { rateAllows, rateEpoch };

export async function takeRate(subject: string, limit: number, now = Date.now()): Promise<boolean> {
  if (limit <= 0) return true;
  const epoch = rateEpoch(now);
  const result = await pool.query<{ hits: number }>(
    `INSERT INTO rate_windows (subject, window_epoch, hits)
     VALUES ($1, $2, 1)
     ON CONFLICT (subject, window_epoch)
     DO UPDATE SET hits = rate_windows.hits + 1
     RETURNING hits`,
    [subject, epoch],
  );
  const hits = Number(result.rows[0]?.hits ?? 1);
  if (hits === 1) {
    pool.query("DELETE FROM rate_windows WHERE window_epoch < $1", [epoch - 2]).catch((error: unknown) => {
      console.error("rate window cleanup failed", error);
    });
  }
  return rateAllows(hits, limit);
}
