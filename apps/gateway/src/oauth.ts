import { randomBytes, randomUUID } from "node:crypto";
import type { Express, RequestHandler, Response } from "express";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type pg from "pg";
import { decryptString, encryptString, hashApiKey } from "./crypto.js";
import { HttpError } from "./errors.js";

const SCOPE = "mcp";
const BLOCKED_PROTOCOLS = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:"]);

export type OAuthRequestRow = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: Date;
};

export type OAuthCodeRow = {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: Date;
  used: boolean;
};

export type OAuthTokenRow = {
  tokenHash: string;
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scopes: string[];
  resource?: string;
  expiresAt: Date;
  revoked: boolean;
};

export interface OAuthStore {
  saveClient(client: OAuthClientInformationFull): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveRequest(row: OAuthRequestRow): Promise<void>;
  getRequest(id: string): Promise<OAuthRequestRow | undefined>;
  deleteRequest(id: string): Promise<void>;
  saveCode(row: OAuthCodeRow): Promise<void>;
  takeCode(codeHash: string): Promise<OAuthCodeRow | undefined>;
  saveToken(row: OAuthTokenRow): Promise<void>;
  getToken(tokenHash: string): Promise<OAuthTokenRow | undefined>;
  revokeHash(tokenHash: string): Promise<void>;
}

type Options = {
  publicUrl: string;
  now?: () => number;
  requestTtlMs?: number;
  codeTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
};

export function allowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (BLOCKED_PROTOCOLS.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

export function createOAuthProvider(store: OAuthStore, options: Options): OAuthServerProvider {
  const now = options.now ?? Date.now;
  const requestTtlMs = options.requestTtlMs ?? 10 * 60 * 1000;
  const codeTtlMs = options.codeTtlMs ?? 5 * 60 * 1000;
  const accessTtlMs = options.accessTtlMs ?? 60 * 60 * 1000;
  const refreshTtlMs = options.refreshTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const resourceUrl = `${options.publicUrl.replace(/\/$/, "")}/mcp`;

  function acceptedResource(resource: URL | undefined): string {
    if (!resource) return resourceUrl;
    if (resource.href.replace(/\/$/, "") !== resourceUrl) {
      throw new InvalidRequestError("Unsupported resource");
    }
    return resourceUrl;
  }

  return {
    get clientsStore() {
      return {
        getClient: (clientId: string) => store.getClient(clientId),
        async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & { client_id?: string; client_id_issued_at?: number }) {
          const full = client as OAuthClientInformationFull;
          if (!full.redirect_uris?.length || full.redirect_uris.some((uri) => !allowedRedirect(uri))) {
            throw new InvalidClientMetadataError("redirect_uri must be https, loopback http, or a private-use scheme");
          }
          await store.saveClient(full);
          return full;
        },
      };
    },

    async authorize(client, params: AuthorizationParams, res: Response) {
      const resource = acceptedResource(params.resource);
      const id = randomUUID();
      await store.saveRequest({
        id,
        clientId: client.client_id,
        clientName: client.client_name || client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: [SCOPE],
        resource,
        expiresAt: new Date(now() + requestTtlMs),
      });
      const consent = new URL("/oauth/consent", options.publicUrl);
      consent.searchParams.set("request", id);
      res.redirect(302, consent.href);
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const code = await store.takeCode(hashApiKey(authorizationCode));
      if (!code || code.used || code.clientId !== client.client_id || code.expiresAt.getTime() <= now()) {
        throw new InvalidGrantError("Invalid authorization code");
      }
      return code.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      const code = await store.takeCode(hashApiKey(authorizationCode));
      if (!code || code.used || code.clientId !== client.client_id || code.expiresAt.getTime() <= now()) {
        throw new InvalidGrantError("Invalid authorization code");
      }
      if (redirectUri && redirectUri !== code.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
      if (resource && resource.href.replace(/\/$/, "") !== code.resource) throw new InvalidGrantError("Unsupported resource");
      await store.saveCode({ ...code, used: true });
      return issueTokens(store, code, accessTtlMs, refreshTtlMs, now);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const row = await store.getToken(hashApiKey(refreshToken));
      if (!row || row.kind !== "refresh" || row.revoked || row.clientId !== client.client_id || row.expiresAt.getTime() <= now()) {
        throw new InvalidGrantError("Invalid refresh token");
      }
      if (scopes?.some((scope) => scope !== SCOPE)) throw new InvalidGrantError("Unsupported scope");
      if (resource && resource.href.replace(/\/$/, "") !== row.resource) throw new InvalidGrantError("Unsupported resource");
      await store.revokeHash(row.tokenHash);
      return issueTokens(
        store,
        {
          userId: row.userId,
          clientId: row.clientId,
          scopes: [SCOPE],
          resource: row.resource,
        },
        accessTtlMs,
        refreshTtlMs,
        now,
      );
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const row = await store.getToken(hashApiKey(token));
      if (!row || row.kind !== "access" || row.revoked || row.expiresAt.getTime() <= now()) {
        throw new InvalidTokenError("Invalid token");
      }
      return {
        token,
        clientId: row.clientId,
        scopes: row.scopes,
        expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
        resource: row.resource ? new URL(row.resource) : undefined,
        extra: { userId: row.userId },
      };
    },

    async revokeToken(_client, request) {
      if (!request.token) return;
      await store.revokeHash(hashApiKey(request.token));
    },
  };
}

async function issueTokens(
  store: OAuthStore,
  source: { userId: string; clientId: string; scopes: string[]; resource?: string },
  accessTtlMs: number,
  refreshTtlMs: number,
  now: () => number,
): Promise<OAuthTokens> {
  const access = `uro_${randomBytes(32).toString("base64url")}`;
  const refresh = `urr_${randomBytes(32).toString("base64url")}`;
  const base = {
    clientId: source.clientId,
    userId: source.userId,
    scopes: source.scopes,
    resource: source.resource,
    revoked: false,
  };
  await store.saveToken({ ...base, tokenHash: hashApiKey(access), kind: "access", expiresAt: new Date(now() + accessTtlMs) });
  await store.saveToken({ ...base, tokenHash: hashApiKey(refresh), kind: "refresh", expiresAt: new Date(now() + refreshTtlMs) });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(accessTtlMs / 1000),
    refresh_token: refresh,
    scope: source.scopes.join(" "),
  };
}

export async function describeRequest(store: OAuthStore, id: string, now = Date.now): Promise<{ clientName: string; scopes: string[] }> {
  const row = await store.getRequest(id);
  if (!row || row.expiresAt.getTime() <= now()) throw new HttpError(404, "Authorization request not found");
  return { clientName: row.clientName, scopes: row.scopes };
}

export async function decideAuthorization(
  store: OAuthStore,
  input: { requestId: string; userId: string; allow: boolean },
  now = Date.now,
): Promise<string> {
  const row = await store.getRequest(input.requestId);
  if (!row || row.expiresAt.getTime() <= now()) throw new HttpError(404, "Authorization request not found");
  await store.deleteRequest(row.id);
  const target = new URL(row.redirectUri);
  if (row.state) target.searchParams.set("state", row.state);
  if (!input.allow) {
    target.searchParams.set("error", "access_denied");
    return target.href;
  }
  const code = `uoc_${randomBytes(32).toString("base64url")}`;
  await store.saveCode({
    codeHash: hashApiKey(code),
    clientId: row.clientId,
    userId: input.userId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: new Date(now() + 5 * 60 * 1000),
    used: false,
  });
  target.searchParams.set("code", code);
  return target.href;
}

let bound: OAuthStore | undefined;

export function bindOAuthStore(store: OAuthStore): void {
  bound = store;
}

export function requireOAuthStore(): OAuthStore {
  if (!bound) throw new HttpError(503, "OAuth is not configured");
  return bound;
}

export async function userIdForAccessToken(token: string): Promise<string | null> {
  if (!bound || !token.startsWith("uro_")) return null;
  const row = await bound.getToken(hashApiKey(token));
  if (!row || row.kind !== "access" || row.revoked || row.expiresAt.getTime() <= Date.now()) return null;
  return row.userId;
}

export function installOAuth(app: Express, provider: OAuthServerProvider, publicUrl: string): void {
  const issuer = new URL(publicUrl);
  const resource = new URL(`${publicUrl.replace(/\/$/, "")}/mcp`);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: resource,
      scopesSupported: [SCOPE],
      resourceName: "Urumi gateway",
    }),
  );
}

export function mcpBearer(provider: OAuthServerProvider, publicUrl: string): RequestHandler {
  const resource = new URL(`${publicUrl.replace(/\/$/, "")}/mcp`);
  const oauth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    expectedResource: resource,
  });
  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token.startsWith("urk_")) {
      next();
      return;
    }
    void oauth(req, res, next);
  };
}

export function createPgOAuthStore(pool: pg.Pool, key: Buffer): OAuthStore {
  return {
    async saveClient(client) {
      const { client_secret: secret, ...rest } = client;
      await pool.query(
        `INSERT INTO oauth_clients (client_id, secret_ciphertext, document) VALUES ($1, $2, $3)`,
        [client.client_id, secret ? encryptString(secret, key) : null, JSON.stringify(rest)],
      );
    },
    async getClient(clientId) {
      const result = await pool.query<{ secret_ciphertext: string | null; document: string }>(
        "SELECT secret_ciphertext, document FROM oauth_clients WHERE client_id = $1",
        [clientId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const document = JSON.parse(row.document) as OAuthClientInformationFull;
      if (row.secret_ciphertext) document.client_secret = decryptString(row.secret_ciphertext, key);
      return document;
    },
    async saveRequest(row) {
      await pool.query(
        `INSERT INTO oauth_requests (id, client_id, client_name, redirect_uri, code_challenge, state, scopes, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.id, row.clientId, row.clientName, row.redirectUri, row.codeChallenge, row.state ?? null, row.scopes.join(" "), row.resource ?? null, row.expiresAt],
      );
    },
    async getRequest(id) {
      const result = await pool.query<{
        id: string;
        client_id: string;
        client_name: string | null;
        redirect_uri: string;
        code_challenge: string;
        state: string | null;
        scopes: string;
        resource: string | null;
        expires_at: Date;
      }>("SELECT * FROM oauth_requests WHERE id = $1", [id]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name || row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        state: row.state ?? undefined,
        scopes: row.scopes.split(" ").filter(Boolean),
        resource: row.resource ?? undefined,
        expiresAt: new Date(row.expires_at),
      };
    },
    async deleteRequest(id) {
      await pool.query("DELETE FROM oauth_requests WHERE id = $1", [id]);
    },
    async saveCode(row) {
      await pool.query(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code_hash) DO UPDATE SET used_at = EXCLUDED.used_at`,
        [row.codeHash, row.clientId, row.userId, row.redirectUri, row.codeChallenge, row.scopes.join(" "), row.resource ?? null, row.expiresAt, row.used ? new Date() : null],
      );
    },
    async takeCode(codeHash) {
      const result = await pool.query<{
        code_hash: string;
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        scopes: string;
        resource: string | null;
        expires_at: Date;
        used_at: Date | null;
      }>("SELECT * FROM oauth_codes WHERE code_hash = $1", [codeHash]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        codeHash: row.code_hash,
        clientId: row.client_id,
        userId: row.user_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scopes: row.scopes.split(" ").filter(Boolean),
        resource: row.resource ?? undefined,
        expiresAt: new Date(row.expires_at),
        used: Boolean(row.used_at),
      };
    },
    async saveToken(row) {
      await pool.query(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (token_hash) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`,
        [row.tokenHash, row.kind, row.clientId, row.userId, row.scopes.join(" "), row.resource ?? null, row.expiresAt, row.revoked ? new Date() : null],
      );
    },
    async getToken(tokenHash) {
      const result = await pool.query<{
        token_hash: string;
        kind: "access" | "refresh";
        client_id: string;
        user_id: string;
        scopes: string;
        resource: string | null;
        expires_at: Date;
        revoked_at: Date | null;
      }>("SELECT * FROM oauth_tokens WHERE token_hash = $1", [tokenHash]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        tokenHash: row.token_hash,
        kind: row.kind,
        clientId: row.client_id,
        userId: row.user_id,
        scopes: row.scopes.split(" ").filter(Boolean),
        resource: row.resource ?? undefined,
        expiresAt: new Date(row.expires_at),
        revoked: Boolean(row.revoked_at),
      };
    },
    async revokeHash(tokenHash) {
      await pool.query("UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash]);
    },
  };
}
