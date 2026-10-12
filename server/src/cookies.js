export function parseCookies(req) {
  const out = {};
  const h = req.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const https = (env) => (env.SITE_BASE || '').startsWith('https://');
const secure = (env) => (https(env) ? '; Secure' : '');
/* On HTTPS the session cookie uses the __Host- prefix: the browser then refuses it unless it is
   Secure, host-only and Path=/ — a cookie no subdomain or insecure page can plant. */
const name = (env, base) => (https(env) ? '__Host-' + base : base);

export function setCookie(env, cname, value, opts) {
  const o = Object.assign({ path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax' }, opts);
  let c = `${cname}=${encodeURIComponent(value)}; Path=${o.path}; SameSite=${o.sameSite}${secure(env)}`;
  if (o.httpOnly) c += '; HttpOnly';
  if (o.maxAge) c += `; Max-Age=${o.maxAge}`;
  return c;
}
export const clearCookie = (env, cname, httpOnly = true) => `${cname}=; Path=/; Max-Age=0; SameSite=Lax${secure(env)}${httpOnly ? '; HttpOnly' : ''}`;

export const SESSION_COOKIE = (env) => name(env, 'afflux_session');
export const INIT_COOKIE = (env) => name(env, 'afflux_init');
export const NEXT_COOKIE = (env) => name(env, 'afflux_next');
export const CONFIRM_COOKIE = (env) => name(env, 'afflux_confirm');
export const FLAG_COOKIE = 'afflux_in';   // readable by the page script; carries no secret

export function sessionCookies(env, token) {
  const maxAge = Number(env.SESSION_MINUTES || 129600) * 60;
  return [
    setCookie(env, SESSION_COOKIE(env), token, { maxAge }),
    setCookie(env, FLAG_COOKIE, '1', { maxAge, httpOnly: false })
  ];
}
export const clearSessionCookies = (env) => [clearCookie(env, SESSION_COOKIE(env)), clearCookie(env, FLAG_COOKIE, false)];
