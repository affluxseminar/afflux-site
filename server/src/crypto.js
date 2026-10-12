/* Signing, encryption and encoding on Web Crypto (Workers and Node 18+).
   Secrets:
     SIGNING_KEY  HMAC for cookies, throttle keys, unsubscribe tokens — rotatable at any time
     INDEX_KEY    HMAC for the address index — stable; rotating it needs a reindex (see admin maintenance)
     DATA_KEY     AES-256-GCM for fields at rest — rotatable with a re-encryption pass
   *_PREVIOUS variants of INDEX_KEY and DATA_KEY are honoured for lookups/decryption during a migration.
   Keys are cached per secret value, never per process, so a changed binding is picked up at once. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlDecode = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const randomId = (prefix) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const cache = new Map(); // secret value -> { key, fp }
async function fingerprint(raw) {
  return b64url(await crypto.subtle.digest('SHA-256', raw)).slice(0, 8);
}
async function hmacKey(secret, name) {
  const value = String(secret || '').replace(/=+$/, '');
  if (!value) throw new Error(`${name} is not set`);
  const k = 'hmac:' + value;
  if (!cache.has(k)) {
    const raw = b64urlDecode(value);
    if (raw.length < 32) throw new Error(`${name} must be at least 32 bytes`);
    cache.set(k, { key: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) });
  }
  return cache.get(k).key;
}
async function aesKey(secret, name) {
  const value = String(secret || '').replace(/=+$/, '');
  if (!value) throw new Error(`${name} is not set`);
  const k = 'aes:' + value;
  if (!cache.has(k)) {
    const raw = b64urlDecode(value);
    if (raw.length !== 32) throw new Error(`${name} must be exactly 32 bytes`);
    cache.set(k, { key: await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']), fp: await fingerprint(raw) });
  }
  return cache.get(k);
}

/* ---- HMAC: signed cookies, throttle keys (SIGNING_KEY) ---- */

export async function sign(env, payload, ttlSeconds) {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SIGNING_KEY, 'SIGNING_KEY'), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
export async function verify(env, token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SIGNING_KEY, 'SIGNING_KEY'), b64urlDecode(sig), enc.encode(body)); } catch (e) { return null; }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(body)));
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}
export async function keyedHash(env, purpose, value) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SIGNING_KEY, 'SIGNING_KEY'), enc.encode(purpose + ':' + value));
  return b64url(sig);
}

/* ---- Address index: "<key fingerprint>.<HMAC>" under INDEX_KEY. The prefix records which key
   produced the entry, so "rows still on the old key" is a plain query, not a guess. ---- */

async function hmacFingerprint(secret) {
  const raw = b64urlDecode(String(secret || '').replace(/=+$/, ''));
  return fingerprint(raw);
}
export async function indexKey(env, value, which = 'current') {
  const secret = which === 'current' ? env.INDEX_KEY : env.INDEX_KEY_PREVIOUS;
  if (!secret) return null;
  const name = which === 'current' ? 'INDEX_KEY' : 'INDEX_KEY_PREVIOUS';
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, name), enc.encode('email-index:' + value));
  if (which === 'legacy') return b64url(sig);                       // version-1 format: no prefix, SIGNING_KEY as the index key
  return `${await hmacFingerprint(secret)}.${b64url(sig)}`;
}
export const indexKeyPrefix = async (env) => `${await hmacFingerprint(env.INDEX_KEY)}.`;
export const previousIndexKeyPrefix = async (env) => `${await hmacFingerprint(env.INDEX_KEY_PREVIOUS)}.`;

/* ---- AES-GCM fields at rest. Ciphertext = "<key fingerprint>." + base64url(iv || ct); AAD binds it to (table, id, field). ---- */

export async function encryptField(env, value, aad) {
  if (value == null || value === '') return null;
  const { key, fp } = await aesKey(env.DATA_KEY, 'DATA_KEY');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(String(value)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return `${fp}.${b64url(out)}`;
}
export function ciphertextKeyId(blob) { return typeof blob === 'string' && blob.includes('.') ? blob.slice(0, blob.indexOf('.')) : null; }
export async function currentKeyId(env) { return (await aesKey(env.DATA_KEY, 'DATA_KEY')).fp; }
export async function previousKeyId(env) { return env.DATA_KEY_PREVIOUS ? (await aesKey(env.DATA_KEY_PREVIOUS, 'DATA_KEY_PREVIOUS')).fp : null; }

/* Returns the plaintext; throws when the blob cannot be decrypted with any configured key — a
   decryption failure is an incident to see, not an empty field. */
export async function decryptField(env, blob, aad) {
  if (blob == null) return null;
  const dot = blob.indexOf('.');
  const fp = dot > 0 ? blob.slice(0, dot) : null;
  const body = dot > 0 ? blob.slice(dot + 1) : blob;
  const candidates = [];
  for (const [secret, name] of [[env.DATA_KEY, 'DATA_KEY'], [env.DATA_KEY_PREVIOUS, 'DATA_KEY_PREVIOUS']]) {
    if (!secret) continue;
    const k = await aesKey(secret, name);
    if (!fp || k.fp === fp) candidates.push(k.key);
  }
  const bytes = b64urlDecode(body);
  for (const key of candidates) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12));
      return dec.decode(pt);
    } catch (e) { /* try the next configured key */ }
  }
  const err = new Error('decrypt failed'); err.code = 'E_DECRYPT'; throw err;
}

export const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
