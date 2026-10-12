/* Verifies the Cloudflare Access JWT that fronts /admin/*. Access itself enforces the identity
   provider's MFA/passkeys; this check makes sure requests actually came through it. Fails closed. */

let jwksCache = { domain: null, at: 0, keys: [], refreshedAt: 0, failedAt: 0, inflight: null, unknownKids: new Map() };
const freshCache = (domain) => { if (jwksCache.domain !== domain) jwksCache = { domain, at: 0, keys: [], refreshedAt: 0, failedAt: 0, inflight: null, unknownKids: new Map() }; };

/* One fetch at a time (single-flight), a forced refresh at most once a minute, and a 60-second
   negative cache per unknown key id: a flood of bogus assertions cannot turn into a flood of fetches. */
async function jwks(teamDomain, force) {
  freshCache(teamDomain);                                   // keys are only ever used for the issuer they came from
  const fresh = Date.now() - jwksCache.at < 3600e3 && jwksCache.keys.length;
  if (fresh && !force) return jwksCache.keys;
  if (force && Date.now() - jwksCache.refreshedAt < 60e3) return jwksCache.keys;
  if (Date.now() - jwksCache.failedAt < 30e3) return jwksCache.keys;   // a failed fetch is not retried for 30 s
  if (!jwksCache.inflight) {
    jwksCache.inflight = (async () => {
      try {
        const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
        if (!res.ok) throw new Error('access: cannot fetch certs');
        const data = await res.json();
        jwksCache.keys = data.keys || []; jwksCache.at = Date.now(); jwksCache.refreshedAt = Date.now();
      } catch (e) { jwksCache.failedAt = Date.now(); throw e; }
      finally { jwksCache.inflight = null; }
    })();
  }
  await jwksCache.inflight;
  return jwksCache.keys;
}

const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function accessConfigured(env) { return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD); }

export async function verifyAccess(req, env) {
  try {
    if (!accessConfigured(env)) {
      // Local development only. Requires BOTH Access variables empty, the explicit flag, and a loopback host.
      const host = new URL(req.url).hostname;
      const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
      if (!env.ACCESS_TEAM_DOMAIN && !env.ACCESS_AUD && env.DEV_ADMIN_BYPASS === 'yes-local-only' && loopback) return { email: 'dev@localhost' };
      return null;
    }
    const token = req.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64u(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64u(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    // Cheap rejections before any key fetch (these unsigned claims are never treated as authorization):
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const audPre = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audPre.includes(env.ACCESS_AUD)) return null;
    const seenBad = jwksCache.unknownKids.get(header.kid);
    if (seenBad && Date.now() - seenBad < 60e3) return null;
    let keys = await jwks(env.ACCESS_TEAM_DOMAIN, false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await jwks(env.ACCESS_TEAM_DOMAIN, true); jwk = keys.find((k) => k.kid === header.kid); }
    if (!jwk) { jwksCache.unknownKids.set(header.kid, Date.now()); if (jwksCache.unknownKids.size > 100) jwksCache.unknownKids.clear(); return null; }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!isNum(payload.exp) || payload.exp <= now) return null;
    if (payload.nbf !== undefined && (!isNum(payload.nbf) || payload.nbf > now + 60)) return null;
    if (payload.iat !== undefined && !isNum(payload.iat)) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (typeof payload.email !== 'string') return null;
    return { email: payload.email };
  } catch (e) {
    return null;
  }
}
