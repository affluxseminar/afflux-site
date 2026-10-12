import { cspPolicy, SECURITY_HEADERS } from '../../src/shared.js';
import { keyedHash } from './crypto.js';
import { throttle } from './db.js';

export function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', cspPolicy({ header: true }));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set('Referrer-Policy', 'same-origin');     // a token in the address never travels to another site in a Referer (no-referrer would null the Origin header our CSRF check relies on)
  h.set('Cache-Control', 'no-store');
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

/* Cross-site request forgery: every state-changing request must come from our own origin. */
export function sameOrigin(req, env) {
  const origin = req.headers.get('Origin');
  const site = new URL(env.SITE_BASE).origin;
  if (origin) return origin === site;
  const fetchSite = req.headers.get('Sec-Fetch-Site');
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  const ref = req.headers.get('Referer');
  if (ref) { try { return new URL(ref).origin === site; } catch (e) { return false; } }
  return false;
}

/* Request bodies are small forms. Content-Length rejects declared oversize early; the stream
   reader counts actual bytes and stops at the cap, so an undeclared or chunked body cannot exceed it. */
export const MAX_BODY = 64 * 1024;
export const MAX_UPLOAD_BODY = 24 * 1024 * 1024;   // the admin's talk editor only: a portrait and two documents
export function bodyTooLarge(req, max = MAX_BODY) {
  const len = Number(req.headers.get('Content-Length') || 0);
  return Number.isFinite(len) && len > max;
}
export async function readForm(req, max = MAX_BODY) {
  const ct = req.headers.get('Content-Type') || '';
  if (!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) return null;
  if (!req.body) return new FormData();
  const reader = req.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch (e) {} const err = new Error('body too large'); err.status = 413; throw err; }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.byteLength; }
  return new Request(req.url, { method: 'POST', headers: { 'Content-Type': ct }, body }).formData();
}
export async function readFields(req) {
  const f = await readForm(req);
  if (!f) return null;
  const o = {};
  for (const [k, v] of f.entries()) o[k] = typeof v === 'string' ? v : '';
  return o;
}

export const clientIp = (req) => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '0.0.0.0';

/* Rate limits for link requests: per client and per address, short windows, keyed hashes only,
   decided by one atomic statement each. Cloudflare's edge rule on /api/* and /ru/api/* is the first line. */
export async function allowLinkRequest(env, req, email) {
  const okIp = await throttle.hit(env, await keyedHash(env, 'throttle', 'ip:' + clientIp(req)), 12, 600);
  const okEm = await throttle.hit(env, await keyedHash(env, 'throttle', 'em:' + email.toLowerCase()), 4, 900);
  return okIp && okEm;
}
export async function allowGeneric(env, req, limit = 60, windowSec = 600) {
  return throttle.hit(env, await keyedHash(env, 'throttle', 'gen:' + clientIp(req)), limit, windowSec);
}

/* Only paths on this site that a visitor may be sent back to after signing in. */
export function safeNext(path) {
  if (typeof path !== 'string') return null;
  if (!/^\/(ru\/)?(go\/(join|recording)\/[A-Za-z0-9._-]+\/|account\/|account\/feedback|talks\/[A-Za-z0-9._-]+\/|upcoming\/|archive\/)?$/.test(path)) return null;
  return path;
}

/* Hosts a protected link may point to (defence in depth for the admin form). */
export function allowedLinkHost(env, url) {
  let u; try { u = new URL(url); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const hosts = String(env.LINK_HOSTS || 'zoom.us,youtube.com,youtu.be').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith('.' + h));
}

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
