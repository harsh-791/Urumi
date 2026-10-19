import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  allowedRedirect,
  createOAuthProvider,
  decideAuthorization,
  describeRequest,
  type OAuthCodeRow,
  type OAuthRequestRow,
  type OAuthStore,
  type OAuthTokenRow,
} from "./oauth.js";

function memoryStore(): OAuthStore {
  const clients = new Map<string, OAuthClientInformationFull>();
  const requests = new Map<string, OAuthRequestRow>();
  const codes = new Map<string, OAuthCodeRow>();
  const tokens = new Map<string, OAuthTokenRow>();
  return {
    async saveClient(client) {
      clients.set(client.client_id, client);
    },
    async getClient(clientId) {
      return clients.get(clientId);
    },
    async saveRequest(row) {
      requests.set(row.id, row);
    },
    async getRequest(id) {
      return requests.get(id);
    },
    async deleteRequest(id) {
      requests.delete(id);
    },
    async saveCode(row) {
      codes.set(row.codeHash, row);
    },
    async takeCode(codeHash) {
      return codes.get(codeHash);
    },
    async saveToken(row) {
      tokens.set(row.tokenHash, row);
    },
    async getToken(tokenHash) {
      return tokens.get(tokenHash);
    },
    async revokeHash(tokenHash) {
      const row = tokens.get(tokenHash);
      if (row) row.revoked = true;
    },
  };
}

function client(): OAuthClientInformationFull {
  return {
    client_id: "cursor",
    client_name: "Cursor",
    redirect_uris: ["http://127.0.0.1:9/callback"],
  };
}

test("redirects allow loopback http and reject public http", () => {
  assert.equal(allowedRedirect("http://127.0.0.1:9/callback"), true);
  assert.equal(allowedRedirect("https://example.com/callback"), true);
  assert.equal(allowedRedirect("cursor://anysphere.cursor-mcp/oauth/callback"), true);
  assert.equal(allowedRedirect("http://evil.example/callback"), false);
  assert.equal(allowedRedirect("javascript:alert(1)"), false);
});

test("an approved login code becomes an access token for that user", async () => {
  const store = memoryStore();
  const provider = createOAuthProvider(store, { publicUrl: "http://app.127.0.0.1.sslip.io" });
  await provider.clientsStore.registerClient?.(client());
  let location = "";
  await provider.authorize(client(), {
    redirectUri: "http://127.0.0.1:9/callback",
    codeChallenge: createHash("sha256").update("verifier").digest("base64url"),
    state: "s1",
    scopes: ["mcp"],
  }, { redirect(_status: number, url: string) { location = url; } } as unknown as Response);

  const requestId = new URL(location).searchParams.get("request");
  assert.ok(requestId);
  const described = await describeRequest(store, requestId);
  assert.equal(described.clientName, "Cursor");

  const back = new URL(await decideAuthorization(store, { requestId, userId: "user-1", allow: true }));
  assert.equal(back.searchParams.get("state"), "s1");
  const code = back.searchParams.get("code");
  assert.ok(code);

  const challenge = await provider.challengeForAuthorizationCode(client(), code);
  assert.equal(challenge, createHash("sha256").update("verifier").digest("base64url"));
  const tokens = await provider.exchangeAuthorizationCode(client(), code, undefined, "http://127.0.0.1:9/callback");
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token?.startsWith("uro_"));

  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.extra?.userId, "user-1");
  assert.equal(info.resource?.href, "http://app.127.0.0.1.sslip.io/mcp");

  await assert.rejects(() => provider.exchangeAuthorizationCode(client(), code), /Invalid authorization code/);

  const refreshed = await provider.exchangeRefreshToken(client(), tokens.refresh_token ?? "");
  assert.ok(refreshed.access_token);
  await provider.revokeToken?.(client(), { token: refreshed.access_token ?? "" });
  await assert.rejects(() => provider.verifyAccessToken(refreshed.access_token ?? ""), /Invalid token/);
});

test("denying the consent screen sends the client access_denied", async () => {
  const store = memoryStore();
  const provider = createOAuthProvider(store, { publicUrl: "http://app.127.0.0.1.sslip.io" });
  let location = "";
  await provider.authorize(client(), {
    redirectUri: "http://127.0.0.1:9/callback",
    codeChallenge: "challenge",
    state: "s2",
    scopes: [],
  }, { redirect(_status: number, url: string) { location = url; } } as unknown as Response);
  const requestId = new URL(location).searchParams.get("request") ?? "";
  const back = new URL(await decideAuthorization(store, { requestId, userId: "user-1", allow: false }));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
});
