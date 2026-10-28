/* EEES application server. Routes are matched here; everything else is a static page on Pages. */
import { withHeaders, sameOrigin, allowGeneric, bodyTooLarge, MAX_UPLOAD_BODY } from './security.js';
import * as auth from './routes/auth.js';
import { getGo } from './routes/go.js';
import { getUnsubscribe, postUnsubscribe } from './routes/unsubscribe.js';
import { admin } from './routes/admin.js';
import { MAX_TEXTS_BODY } from './routes/texts.js';
import { pending, throttle } from './db.js';
import { identity } from './identity/index.js';

function route(req) {
  const url = new URL(req.url);
  let p = url.pathname;
  let lang = 'en';
  if (p === '/ru' || p.startsWith('/ru/')) { lang = 'ru'; p = p.slice(3) || '/'; }
  return { url, p, lang, m: req.method };
}

/* The public site keeps no data about visitors: with REGISTRATION = "closed" every participant-facing
   dynamic path (registration, sign-in, account, protected links, their APIs) is shut. GET requests are
   sent to the public site's front page; anything else gets 404. The admin and the health check are
   unaffected. */
const PARTICIPANT_PATHS = /^\/(register|signin|account|go|api)(\/|$)/;
function closedRegistration(env, p, lang, m) {
  if (env.REGISTRATION !== 'closed' || p === '/api/health' || !PARTICIPANT_PATHS.test(p)) return null;
  if (m === 'GET' || m === 'HEAD') return new Response(null, { status: 302, headers: { Location: `${env.PUBLIC_SITE || ''}${lang === 'ru' ? '/ru/' : '/'}` } });
  return new Response('Not found', { status: 404 });
}

/* The Worker lives on its own host (admin.eeeseminar.org) while the public site is served
   elsewhere (PUBLIC_SITE). On the admin host only the admin, the health check and the static assets
   the admin pages use are served; any other path is sent to the public site. Without PUBLIC_SITE
   (the dev environment) the Worker serves the whole static site itself, as before. */
const ADMIN_HOST_ASSETS = /^\/(assets\/|photos\/|files\/|programme\.json$|favicon\.(svg|ico)$|apple-touch-icon\.png$|content-version\.txt$)/;
function adminHostOnly(req, env, p, m) {
  if (!env.PUBLIC_SITE || p === '/admin' || p.startsWith('/admin/') || p === '/api/health' || ADMIN_HOST_ASSETS.test(p)) return null;
  const url = new URL(req.url);
  if (m === 'GET' || m === 'HEAD') return new Response(null, { status: 302, headers: { Location: `${env.PUBLIC_SITE}${url.pathname}${url.search}` } });
  return new Response('Not found', { status: 404 });
}

const STATIC = new WeakSet();   // responses from the assets binding: their headers come from _headers, not from withHeaders

async function handle(req, env) {
  const { p, lang, m } = route(req);
  const closed = closedRegistration(env, p, lang, m);
  if (closed) return closed;
  const away = adminHostOnly(req, env, p, m);
  if (away) return away;

  if (m === 'GET' || m === 'HEAD') {
    if (p === '/api/health') return new Response('ok');
    if (p === '/register/' || p === '/register') return auth.getRegister(req, env, lang);
    if (p === '/signin/' || p === '/signin') return auth.getSignin(req, env, lang);
    if (p === '/account/verify') return auth.getVerify(req, env, lang);
    if (p === '/account/' || p === '/account') return auth.getAccount(req, env, lang);
    if (p === '/account/feedback') return auth.getFeedback(req, env, lang);
    if (p === '/api/unsubscribe') return getUnsubscribe(req, env, lang);
    const go = p.match(/^\/go\/(join|recording)\/([^/]+)\/?$/);
    if (go) return getGo(req, env, lang, go[1], go[2]);
    if (p === '/admin' || p.startsWith('/admin/')) return admin(req, env, p.replace(/^\/admin/, '').replace(/\/$/, ''));
    // Everything else is a static file (every request passes through the Worker: run_worker_first = true).
    if (env.ASSETS) { const r = await env.ASSETS.fetch(req); STATIC.add(r); return r; }
    return new Response('Not found', { status: 404 });
  }

  if (m === 'POST') {
    if (bodyTooLarge(req, p === '/admin/talks/save' ? MAX_UPLOAD_BODY : p === '/admin/texts/save' ? MAX_TEXTS_BODY : undefined)) return new Response('Payload too large', { status: 413 });
    if (p === '/api/unsubscribe') return postUnsubscribe(req, env, lang);   // signed token is the authorization
    if (!sameOrigin(req, env)) return new Response('Forbidden', { status: 403 });
    if (!(await allowGeneric(env, req))) return new Response('Too many requests', { status: 429 });
    if (p === '/api/register') return auth.postRegister(req, env);
    if (p === '/api/signin') return auth.postSignin(req, env);
    if (p === '/api/verify') return auth.postVerify(req, env);
    if (p === '/api/profile') return auth.postProfile(req, env);
    if (p === '/api/account') return auth.postAccount(req, env);
    if (p === '/api/signout') return auth.postSignout(req, env);
    if (p === '/api/delete') return auth.postDelete(req, env);
    if (p === '/api/feedback') return auth.postFeedback(req, env);
    if (p === '/admin' || p.startsWith('/admin/')) return admin(req, env, p.replace(/^\/admin/, '').replace(/\/$/, ''));
    return new Response('Not found', { status: 404 });
  }
  return new Response('Method not allowed', { status: 405 });
}

export default {
  async fetch(req, env) {
    try {
      const res = await handle(req, env);
      if (STATIC.has(res)) return res;
      return withHeaders(res, env.PUBLIC_SITE ? { 'X-Robots-Tag': 'noindex' } : undefined);   // the admin host is not for search engines
    } catch (e) {
      if (e && e.status === 413) return withHeaders(new Response('Payload too large', { status: 413 }));
      if (e && e.code === 'E_KEY_GENERATION') return withHeaders(new Response('Temporarily unavailable, please try again in a moment', { status: 503, headers: { 'Retry-After': '5' } }));
      // Only an error code reaches the logs — never a message that could carry a token, an address or a name.
      console.error('afflux-server error', (e && e.code) || (e && e.status) || 'E_UNHANDLED');
      if (env.DEBUG_ERRORS === 'yes-local-only') console.error(e && e.stack);   // dev environment only (wrangler.toml); never in production
      return withHeaders(new Response('Server error', { status: 500 }));
    }
  },

  /* Daily: unverified registrations expire together with the provider's pending user; throttle rows are purged. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const id = identity(env);
      const removed = await id.housekeeping();                 // unverified identities past their time, dead tokens and sessions
      for (const uid of removed) await pending.remove(env, uid);
      for (const uid of await pending.expired(env)) {          // and any pending profile whose identity is gone or still unverified
        const u = await id.getUser(uid);
        if (!u || u.status === 'pending') await id.deleteUser(uid);
        await pending.remove(env, uid);
      }
      await throttle.purge(env);
    })());
  }
};
