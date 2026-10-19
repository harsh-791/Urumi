import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { HttpError } from "./errors.js";
import { requireUser } from "./api.js";
import { RESERVED_SLUGS, storeNamespace, storeUrl } from "./storeplan.js";
import { validSlug } from "./tools.js";

type StoreRow = {
  id: string;
  owner_id: string;
  owner_email: string;
  slug: string;
  name: string;
  namespace: string;
  url: string;
  status: "provisioning" | "ready" | "failed" | "deleting";
  status_detail: string | null;
  created_at: Date;
};

function publicStore(row: StoreRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    namespace: row.namespace,
    url: row.url,
    status: row.status,
    statusDetail: row.status_detail,
    ownerEmail: row.owner_email,
    createdAt: row.created_at,
  };
}

const SELECT = `
  SELECT stores.*, users.email AS owner_email
  FROM stores JOIN users ON users.id = stores.owner_id
`;

export async function listStores(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query<StoreRow>(
    `${SELECT} WHERE ($1::text = 'admin' OR stores.owner_id = $2) ORDER BY stores.created_at DESC`,
    [user.role, user.id],
  );
  res.json({ stores: result.rows.map(publicStore) });
}

export async function createStore(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const name = String(req.body?.name ?? "").trim();
  const slug = String(req.body?.slug ?? "").trim().toLowerCase();
  if (!name || name.length > 80) throw new HttpError(400, "Name is required");
  if (!validSlug(slug)) throw new HttpError(400, "Slug must be a short lowercase name");
  if (RESERVED_SLUGS.has(slug)) throw new HttpError(400, "That slug is reserved");

  const count = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM stores WHERE owner_id = $1 AND status <> 'deleting'`,
    [user.id],
  );
  if (Number(count.rows[0]?.n ?? 0) >= config.stores.maxPerUser) {
    throw new HttpError(400, `You can have ${config.stores.maxPerUser} stores`);
  }
  const taken = await pool.query("SELECT id FROM mcp_servers WHERE slug = $1", [slug]);
  if (taken.rowCount) throw new HttpError(409, "That slug is already an MCP server");

  const id = randomUUID();
  const namespace = storeNamespace(slug);
  const url = storeUrl(slug, config.stores.hostSuffix);
  try {
    await pool.query(
      `INSERT INTO stores (id, owner_id, slug, name, namespace, url, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'provisioning')`,
      [id, user.id, slug, name, namespace, url],
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new HttpError(409, "That store already exists");
    }
    throw error;
  }
  res.status(202).json({ id, slug, name, namespace, url, status: "provisioning" });
}

export async function retryStore(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query(
    `UPDATE stores SET status = 'provisioning', status_detail = NULL, attempt_started_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'failed' AND ($2::text = 'admin' OR owner_id = $3)`,
    [req.params.id, user.role, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, "Failed store not found");
  res.json({ ok: true });
}

export async function deleteStore(req: Request, res: Response): Promise<void> {
  const user = requireUser(req);
  const result = await pool.query(
    `UPDATE stores SET status = 'deleting', status_detail = NULL, updated_at = now()
     WHERE id = $1 AND status <> 'deleting' AND ($2::text = 'admin' OR owner_id = $3)`,
    [req.params.id, user.role, user.id],
  );
  if (result.rowCount === 0) throw new HttpError(404, "Store not found");
  res.status(202).json({ ok: true });
}
