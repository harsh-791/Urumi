import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { decryptString, encryptString, generateApiKey, hashApiKey, hashPassword, verifyPassword } from "./crypto.js";

test("password hash verifies and rejects a wrong password", async () => {
  const stored = await hashPassword("correct horse");
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("wrong horse", stored), false);
  assert.equal(await verifyPassword("correct horse", "nope"), false);
});

test("api keys hash stably and only the prefix is short", () => {
  const key = generateApiKey();
  assert.equal(key.plaintext.startsWith("urk_"), true);
  assert.equal(key.prefix, key.plaintext.slice(0, 12));
  assert.equal(hashApiKey(key.plaintext), key.hash);
  assert.notEqual(key.hash, key.plaintext);
});

test("credential encryption round-trips and rejects another key", () => {
  const key = randomBytes(32);
  const payload = encryptString("ck_secret", key);
  assert.equal(decryptString(payload, key), "ck_secret");
  assert.throws(() => decryptString(payload, randomBytes(32)));
});
