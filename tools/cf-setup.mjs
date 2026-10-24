#!/usr/bin/env node
/* One-off Cloudflare setup for EEES, run by the "Cloudflare setup" workflow (or by hand).
   Every step is idempotent: run it again and it reports what already exists. Nothing here
   touches secrets: the six Worker secrets are entered in the dashboard by the owner.

   Usage: CF_SETUP_TOKEN=… node tools/cf-setup.mjs --mailbox you@example.org [--steps a,b,c] [--site DIR]
   Steps: account d1 subdomain zone ech dns email redirects ratelimit access pages summary   (default: all)
          records — only when named: the DNS records listed in tools/cf-dns.json (for example a mail
          service's DKIM and SPF), created or updated in the zone their name belongs to.
          retire — only when named: the former domain (affluxseminar.org/.com) becomes a 301 to the new one
          and the admin leaves admin.affluxseminar.org. Run it once GitHub Pages serves the new domain.
   Writes: cf-setup.out.json (ids for wrangler.toml) and patches server/wrangler.toml in place
   so that `wrangler d1 migrations apply` and `wrangler deploy` can run right after. */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = String(process.env.CF_SETUP_TOKEN || '').trim().replace(/^("|')|("|')$/g, '').replace(/^Bearer\s+/i, '');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MAILBOX = opt('--mailbox', process.env.MAILBOX || '');
const STEPS = opt('--steps', 'all').split(',').map((s) => s.trim()).filter(Boolean);
const SITE = opt('--site', '.');
const ORG = 'eeeseminar.org';                        // the seminar's domain since 24 Oct 2026 (EEES)
const OLD_ORG = 'affluxseminar.org', OLD_COM = 'affluxseminar.com';   // the former name: permanent 301s to ORG
const SEMINAR = `seminar@${ORG}`;
const TEAM = 'affluxseminar';                       // Access team (→ affluxseminar.cloudflareaccess.com) and GitHub owner (affluxseminar.github.io); not shown to visitors
const ADMIN = `admin.${ORG}`;                        // the Worker (programme editor) lives here; the public site is on GitHub Pages
const OLD_ADMIN = `admin.${OLD_ORG}`;
const want = (s) => STEPS.includes(s) || (STEPS.includes('all') && s !== 'retire' && s !== 'records');
const out = existsSync('cf-setup.out.json') ? JSON.parse(readFileSync('cf-setup.out.json', 'utf8')) : {};
const save = () => writeFileSync('cf-setup.out.json', JSON.stringify(out, null, 2) + '\n');
const log = (...a) => console.log(...a);
const warn = (...a) => console.log('  !', ...a);

if (!TOKEN) { console.error('CF_SETUP_TOKEN is not set'); process.exit(2); }

async function cf(method, path, body, { ok404 = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (res.status === 404 && ok404) return null;
  if (!res.ok || (data && data.success === false)) {
    const errs = (data && data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ');
    const e = new Error(`${method} ${path} → ${res.status} ${errs}`);
    e.status = res.status; e.errors = data && data.errors || []; e.data = data;
    throw e;
  }
  return data ? data.result : null;
}
const has = (e, code) => e.errors && e.errors.some((x) => x.code === code);
const forbidden = (e) => e.status === 403 || has(e, 10000) || has(e, 9109);

/* ---------- account and zones ---------- */
async function account() {
  try {
    const v = await cf('GET', '/user/tokens/verify');
    log(`token: ${v.status}${v.expires_on ? `, valid until ${v.expires_on}` : ''}${v.not_before ? `, not before ${v.not_before}` : ''} (${TOKEN.length} characters)`);
  } catch (e) { warn(`token check: ${e.message} (${TOKEN.length} characters after trimming) — in Cloudflare → My Profile → API Tokens check that afflux-setup is Active and its dates are right, then paste it into the CF_SETUP_TOKEN secret again`); throw e; }
  const accounts = await cf('GET', '/accounts?per_page=50');
  if (!accounts.length) throw new Error('no account visible to this token (needs Account Settings: Read)');
  if (accounts.length > 1) warn(`${accounts.length} accounts visible; using the first: ${accounts[0].name}`);
  out.account_id = accounts[0].id; out.account_name = accounts[0].name;
  log(`account: ${accounts[0].name} (${accounts[0].id})`);
  for (const [key, name] of [['zone_org', ORG], ['zone_old_org', OLD_ORG], ['zone_old_com', OLD_COM]]) {
    const z = await cf('GET', `/zones?name=${name}`);
    if (!z.length) { warn(`zone ${name} is not in this account`); continue; }
    out[key] = z[0].id;
    log(`zone ${name}: ${z[0].id} status=${z[0].status} plan=${z[0].plan && z[0].plan.name}`);
  }
  save();
}

/* ---------- D1: three databases in Western Europe ---------- */
const DBS = [['IDENTITY_DB', 'afflux_identity'], ['USERS_DB', 'afflux_users'], ['LINKS_DB', 'afflux_links']];
async function d1() {
  out.d1 = out.d1 || {};
  for (const [binding, name] of DBS) {
    const list = await cf('GET', `/accounts/${out.account_id}/d1/database?name=${name}&per_page=100`);
    let db = list.find((x) => x.name === name);
    if (db) log(`d1 ${name}: exists (${db.uuid})`);
    else { db = await cf('POST', `/accounts/${out.account_id}/d1/database`, { name, primary_location_hint: 'weur' }); log(`d1 ${name}: created (${db.uuid}) in weur`); }
    out.d1[binding] = { name, id: db.uuid };
  }
  save();
  /* patch server/wrangler.toml so migrations and deploy can run in this checkout */
  const p = `${SITE}/server/wrangler.toml`;
  let toml = readFileSync(p, 'utf8');
  for (const [binding, name] of DBS) {
    const re = new RegExp(`(binding = "${binding}"\\ndatabase_name = "${name}"\\ndatabase_id = ")[^"]*(")`);
    if (!re.test(toml)) warn(`wrangler.toml: block for ${binding} not found`);
    toml = toml.replace(re, `$1${out.d1[binding].id}$2`);
  }
  writeFileSync(p, toml);
  log('wrangler.toml patched with the database ids (commit these):');
  for (const [binding] of DBS) log(`  ${binding} = ${out.d1[binding].id}`);
}

/* ---------- workers.dev subdomain: the account needs one before cron triggers can be set ---------- */
async function subdomain() {
  let cur = null;
  try { cur = await cf('GET', `/accounts/${out.account_id}/workers/subdomain`, undefined, { ok404: true }); } catch (e) { if (!has(e, 10007)) throw e; }
  if (cur && cur.subdomain) { log(`workers.dev subdomain: ${cur.subdomain}.workers.dev (exists; workers_dev = false keeps it unused)`); return; }
  const r = await cf('PUT', `/accounts/${out.account_id}/workers/subdomain`, { subdomain: TEAM });
  log(`workers.dev subdomain: ${r.subdomain}.workers.dev registered (required by the API; the Worker is not published on it)`);
}

/* ---------- zone settings ---------- */
async function zone() {
  const settings = { ssl: 'strict', always_use_https: 'on', min_tls_version: '1.2', tls_1_3: 'on', automatic_https_rewrites: 'on', opportunistic_encryption: 'on' };
  for (const key of ['zone_org', 'zone_old_org', 'zone_old_com']) {
    if (!out[key]) continue;
    for (const [id, value] of Object.entries(settings)) {
      try { const r = await cf('PATCH', `/zones/${out[key]}/settings/${id}`, { value }); log(`${key} ${id}: ${r.value}`); }
      catch (e) { warn(`${key} ${id}: ${e.message}`); }
    }
  }
}

/* ---------- reachability from Russia: no ECH (TSPU drops TLS handshakes that carry it) ---------- */
async function ech() {
  for (const key of ['zone_org', 'zone_old_org', 'zone_old_com']) {
    if (!out[key]) continue;
    try { const r = await cf('PATCH', `/zones/${out[key]}/settings/ech`, { value: 'off' }); log(`${key} ech: ${r.value}`); }
    catch (e) { warn(`${key} ech: ${e.message}`); }
  }
}

/* ---------- DNS ---------- */
async function dnsUpsert(zoneId, type, name, content, { proxied } = {}) {
  const list = await cf('GET', `/zones/${zoneId}/dns_records?type=${type}&name=${name}&per_page=100`);
  const strip = (s) => String(s || '').replace(/^"|"$/g, '');
  if (type === 'TXT') {
    const prefix = strip(content).split(' ')[0];                 // v=spf1 / v=DMARC1
    const same = list.find((r) => strip(r.content).startsWith(prefix));
    if (same && strip(same.content) === strip(content)) { log(`dns ${name} ${type}: ok`); return; }
    if (same) { await cf('PATCH', `/zones/${zoneId}/dns_records/${same.id}`, { content }); log(`dns ${name} ${type}: updated`); return; }
  } else {
    const same = list.find((r) => strip(r.content) === content);
    if (same) { if (proxied !== undefined && same.proxied !== proxied) { await cf('PATCH', `/zones/${zoneId}/dns_records/${same.id}`, { proxied }); log(`dns ${name} ${type}: proxied=${proxied}`); } else log(`dns ${name} ${type}: ok`); return; }
  }
  await cf('POST', `/zones/${zoneId}/dns_records`, { type, name, content, ttl: 1, ...(proxied !== undefined ? { proxied } : {}) });
  log(`dns ${name} ${type}: created`);
}
async function dns() {
  if (out.zone_org) {
    await dnsUpsert(out.zone_org, 'TXT', ORG, 'v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all');
    await dnsUpsert(out.zone_org, 'TXT', `_dmarc.${ORG}`, `v=DMARC1; p=none; rua=mailto:${SEMINAR}; adkim=r; aspf=r`);
    await dnsUpsert(out.zone_org, 'CNAME', `www.${ORG}`, `${TEAM}.github.io`, { proxied: false });   // GitHub Pages redirects www to the apex
  }
}

/* ---------- Email Routing: seminar@ → the mailbox ---------- */
async function email() {
  if (!out.zone_org) return;
  if (!MAILBOX) { warn('no --mailbox given; skipping Email Routing'); return; }
  try { await cf('POST', `/zones/${out.zone_org}/email/routing/enable`); log('email routing: enabled (MX and SPF records added)'); }
  catch (e) { if (/already|enabled/i.test(e.message)) log('email routing: already enabled'); else throw e; }
  const addrs = await cf('GET', `/accounts/${out.account_id}/email/routing/addresses?per_page=50`);
  let dest = addrs.find((a) => a.email.toLowerCase() === MAILBOX.toLowerCase());
  if (!dest) { dest = await cf('POST', `/accounts/${out.account_id}/email/routing/addresses`, { email: MAILBOX }); log(`destination ${MAILBOX}: added — a verification message was sent to it; open it and confirm`); }
  else log(`destination ${MAILBOX}: ${dest.verified ? 'verified' : 'NOT yet verified — open the message from Cloudflare and confirm'}`);
  out.mailbox = MAILBOX; out.mailbox_verified = !!dest.verified; save();
  const rules = await cf('GET', `/zones/${out.zone_org}/email/routing/rules?per_page=50`);
  const rule = rules.find((r) => (r.matchers || []).some((m) => m.type === 'literal' && m.value === SEMINAR));
  if (rule) { log(`rule ${SEMINAR} → ${rule.actions.map((a) => a.value).flat().join(', ')}: exists`); return; }
  if (!dest.verified) { warn(`rule ${SEMINAR} → ${MAILBOX}: not created yet (destination must be verified first); re-run step "email" afterwards`); return; }
  await cf('POST', `/zones/${out.zone_org}/email/routing/rules`, { name: 'seminar', enabled: true, matchers: [{ type: 'literal', field: 'to', value: SEMINAR }], actions: [{ type: 'forward', value: [MAILBOX] }] });
  log(`rule ${SEMINAR} → ${MAILBOX}: created`);
  /* the SPF record Email Routing writes lacks SMTP2GO; put ours back */
  await dnsUpsert(out.zone_org, 'TXT', ORG, 'v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all');
}

/* ---------- redirects: www and the former .com → https://eeeseminar.org ---------- */
const redirectRule = (expression, description, host = ORG) => ({ action: 'redirect', description, enabled: true, expression,
  action_parameters: { from_value: { status_code: 301, target_url: { expression: `concat("https://${host}", http.request.uri.path)` }, preserve_query_string: true } } });
async function putRedirects(zoneId, rules, label) {
  try { await cf('PUT', `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { rules }); log(`redirect ${label}: set`); }
  catch (e) { warn(`redirect ${label}: ${e.message}${forbidden(e) ? '  (token needs Zone → Single Redirect → Edit)' : ''}`); process.exitCode = 1; }
}
async function redirects() {
  if (out.zone_org) await putRedirects(out.zone_org, [redirectRule(`(http.host eq "www.${ORG}")`, 'www → apex')], 'www.' + ORG);
  if (out.zone_old_com) await putRedirects(out.zone_old_com, [redirectRule('true', `${OLD_COM} → ${ORG}`)], OLD_COM);
}

/* ---------- rate limiting on the dynamic paths (one rule, free plan) ---------- */
async function ratelimit() {
  if (!out.zone_org) return;
  const paths = ['/api/', '/ru/api/', '/admin', '/ru/admin', '/register', '/ru/register', '/signin', '/ru/signin'];
  const expression = '(' + paths.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(' or ') + ')';
  const rules = [{ action: 'block', description: 'EEES: 40 requests per 10 s per IP on the dynamic paths', enabled: true, expression,
    ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period: 10, requests_per_period: 40, mitigation_timeout: 10 } }];
  try { await cf('PUT', `/zones/${out.zone_org}/rulesets/phases/http_ratelimit/entrypoint`, { rules }); log('rate limit: set (40 / 10 s per IP on api, admin, register, signin)'); }
  catch (e) { warn(`rate limit: ${e.message}${forbidden(e) ? '  (token needs Zone → Zone WAF → Edit)' : ''}`); }
}

/* ---------- Cloudflare Access on /admin: one-time PIN to the mailbox ---------- */
async function access() {
  if (!MAILBOX) { warn('no --mailbox given; skipping Access'); return; }
  const acc = out.account_id;
  let org = null;
  try { org = await cf('GET', `/accounts/${acc}/access/organizations`, undefined, { ok404: true }); } catch (e) { if (!forbidden(e)) throw e; warn(`access organization: cannot read (${e.message})`); }
  if (!org || !org.auth_domain) {
    try { org = await cf('POST', `/accounts/${acc}/access/organizations`, { name: 'EEES', auth_domain: `${TEAM}.cloudflareaccess.com`, is_ui_read_only: false }); log(`access organization: created ${org.auth_domain}`); }
    catch (e) { warn(`access organization: ${e.message}`); warn('→ create it once in the dashboard: Zero Trust → choose a team name (affluxseminar) → Free plan; then re-run step "access"'); return; }
  } else log(`access organization: ${org.auth_domain}`);
  /* the name shown above the admin's sign-in form */
  if (org.name !== 'EEES') {
    try { await cf('PUT', `/accounts/${acc}/access/organizations`, { name: 'EEES', auth_domain: org.auth_domain }); log('access organization: renamed to EEES'); }
    catch (e) { warn(`access organization name: ${e.message}${forbidden(e) ? '  (token needs Access: Organizations, Identity Providers, and Groups → Edit)' : ''}`); }
  }
  out.access_team_domain = org.auth_domain; save();
  const idps = await cf('GET', `/accounts/${acc}/access/identity_providers?per_page=50`);
  let otp = idps.find((i) => i.type === 'onetimepin');
  if (!otp) { otp = await cf('POST', `/accounts/${acc}/access/identity_providers`, { name: 'One-time PIN', type: 'onetimepin', config: {} }); log('access idp: one-time PIN created'); }
  else log('access idp: one-time PIN exists');
  const apps = await cf('GET', `/accounts/${acc}/access/apps?per_page=100`);
  let app = apps.find((a) => a.name === 'EEES admin') || apps.find((a) => a.name === 'AFFLUX admin');
  /* While the former admin host still serves the Worker (until step "retire"), Access guards both. */
  const hosts = want('retire') || !out.zone_old_org ? [ADMIN] : [ADMIN, OLD_ADMIN];
  const body = { name: 'EEES admin', type: 'self_hosted', domain: `${ADMIN}/admin`, self_hosted_domains: hosts.flatMap((h) => [`${h}/admin`, `${h}/ru/admin`]),
    session_duration: '24h', allowed_idps: [otp.id], auto_redirect_to_identity: true, app_launcher_visible: false, http_only_cookie_attribute: true, same_site_cookie_attribute: 'lax', enable_binding_cookie: true, skip_interstitial: true };
  if (!app) { app = await cf('POST', `/accounts/${acc}/access/apps`, body); log(`access app: created (aud ${app.aud})`); }
  else { app = await cf('PUT', `/accounts/${acc}/access/apps/${app.id}`, body); log(`access app: exists, settings refreshed for ${hosts.join(', ')} (aud ${app.aud})`); }
  out.access_aud = app.aud; save();
  const pols = await cf('GET', `/accounts/${acc}/access/apps/${app.id}/policies`);
  const pbody = { name: 'Owner', decision: 'allow', precedence: 1, include: [{ email: { email: MAILBOX } }] };
  const pol = pols.find((p) => p.name === 'Owner');
  if (!pol) { await cf('POST', `/accounts/${acc}/access/apps/${app.id}/policies`, pbody); log(`access policy: allow ${MAILBOX}`); }
  else { await cf('PUT', `/accounts/${acc}/access/apps/${app.id}/policies/${pol.id}`, pbody); log(`access policy: allow ${MAILBOX} (refreshed)`); }
  /* write the two values into wrangler.toml (production block only) */
  const p = `${SITE}/server/wrangler.toml`;
  let toml = readFileSync(p, 'utf8');
  toml = toml.replace(/^ACCESS_TEAM_DOMAIN = ""(.*)$/m, `ACCESS_TEAM_DOMAIN = "${org.auth_domain}"$1`).replace(/^ACCESS_AUD = ""(.*)$/m, `ACCESS_AUD = "${app.aud}"$1`);
  writeFileSync(p, toml);
  log('wrangler.toml patched with ACCESS_TEAM_DOMAIN and ACCESS_AUD (commit these)');
}

/* ---------- GitHub Pages: the public site leaves Cloudflare's proxy ----------
   The apex and www point straight at GitHub Pages (DNS only, grey cloud): Russian providers throttle
   Cloudflare-proxied sites, GitHub Pages they do not. The Worker keeps admin.<domain> as its custom
   domain (wrangler.toml); its former apex custom domain is removed here so that the apex records can
   be replaced. The .com stays proxied: a 301 is small enough to pass. */
const PAGES_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
const PAGES_AAAA = ['2606:50c0:8000::153', '2606:50c0:8001::153', '2606:50c0:8002::153', '2606:50c0:8003::153'];
async function pages() {
  if (!out.zone_org) return;
  const domains = await cf('GET', `/accounts/${out.account_id}/workers/domains?zone_id=${out.zone_org}`);
  for (const d of domains.filter((x) => x.hostname === ORG)) { await cf('DELETE', `/accounts/${out.account_id}/workers/domains/${d.id}`); log(`worker custom domain ${ORG}: removed (the Worker is on ${ADMIN})`); }
  /* whatever sits on the apex now (the Worker's placeholder, old A records) goes; then the GitHub Pages set */
  const apex = await cf('GET', `/zones/${out.zone_org}/dns_records?name=${ORG}&per_page=100`);
  for (const r of apex.filter((x) => ['A', 'AAAA', 'CNAME'].includes(x.type) && !PAGES_A.includes(x.content) && !PAGES_AAAA.includes(x.content))) { await cf('DELETE', `/zones/${out.zone_org}/dns_records/${r.id}`); log(`dns ${ORG} ${r.type} ${r.content}: removed`); }
  for (const ip of PAGES_A) await dnsUpsert(out.zone_org, 'A', ORG, ip, { proxied: false });
  for (const ip of PAGES_AAAA) await dnsUpsert(out.zone_org, 'AAAA', ORG, ip, { proxied: false });
  const www = await cf('GET', `/zones/${out.zone_org}/dns_records?name=www.${ORG}&per_page=100`);
  for (const r of www.filter((x) => !(x.type === 'CNAME' && x.content === `${TEAM}.github.io`))) { await cf('DELETE', `/zones/${out.zone_org}/dns_records/${r.id}`); log(`dns www.${ORG} ${r.type} ${r.content}: removed`); }
  await dnsUpsert(out.zone_org, 'CNAME', `www.${ORG}`, `${TEAM}.github.io`, { proxied: false });   // GitHub redirects www to the apex itself
  log(`GitHub Pages: in the repository Settings → Pages set the custom domain ${ORG} and tick "Enforce HTTPS" once the certificate is issued`);
}

/* ---------- retire: the former domain becomes a permanent redirect ----------
   affluxseminar.org leaves GitHub Pages (whose custom domain is now eeeseminar.org) and is answered by
   Cloudflare with a 301 to the same path on eeeseminar.org; admin.affluxseminar.org → admin.eeeseminar.org.
   A 301 is small enough to pass the Russian throttling of Cloudflare-proxied hosts (as the .com did).
   Mail to seminar@affluxseminar.org keeps arriving: the MX records and the routing rule stay. */
async function retire() {
  if (!out.zone_old_org) { warn(`zone ${OLD_ORG} is not in this account; nothing to retire`); return; }
  const z = out.zone_old_org;
  /* the admin moves only once the Worker already answers on the new host */
  const doms = await cf('GET', `/accounts/${out.account_id}/workers/domains?per_page=100`);
  const onNew = doms.some((d) => d.hostname === ADMIN);
  for (const d of doms.filter((x) => x.hostname === OLD_ADMIN || x.hostname === OLD_ORG)) {
    if (!onNew) { warn(`worker custom domain ${d.hostname}: kept (the Worker is not on ${ADMIN} yet; deploy first, then re-run "retire")`); continue; }
    await cf('DELETE', `/accounts/${out.account_id}/workers/domains/${d.id}`); log(`worker custom domain ${d.hostname}: removed`);
  }
  const hosts = [OLD_ORG, `www.${OLD_ORG}`].concat(onNew ? [OLD_ADMIN] : []);
  for (const host of hosts) {
    const recs = await cf('GET', `/zones/${z}/dns_records?name=${host}&per_page=100`);
    for (const r of recs.filter((x) => ['A', 'AAAA', 'CNAME'].includes(x.type) && !((x.content === '192.0.2.1' || x.content === '100::') && x.proxied))) {
      await cf('DELETE', `/zones/${z}/dns_records/${r.id}`); log(`dns ${host} ${r.type} ${r.content}: removed`);
    }
    await dnsUpsert(z, 'A', host, '192.0.2.1', { proxied: true });
    await dnsUpsert(z, 'AAAA', host, '100::', { proxied: true });
  }
  await putRedirects(z, [
    redirectRule(`(http.host eq "${OLD_ADMIN}")`, `${OLD_ADMIN} → ${ADMIN}`, ADMIN),
    redirectRule('true', `${OLD_ORG} → ${ORG}`)
  ], OLD_ORG);
  if (out.zone_old_com) await putRedirects(out.zone_old_com, [redirectRule('true', `${OLD_COM} → ${ORG}`)], OLD_COM);
  if (onNew && MAILBOX) await access();
}

/* ---------- records: extra DNS records kept in tools/cf-dns.json ----------
   [{ "type": "TXT", "name": "eeeseminar.org", "content": "v=spf1 …" }, { "type": "CNAME", "name": "…", "content": "…" }]
   One SPF record per name: a TXT starting with v=spf1 replaces the existing one. Records are never
   proxied (mail and verification records must not be). Nothing is deleted here. */
async function records() {
  const file = `${SITE}/tools/cf-dns.json`;
  if (!existsSync(file)) { warn('tools/cf-dns.json not found'); return; }
  const list = JSON.parse(readFileSync(file, 'utf8'));
  const zones = [[ORG, out.zone_org], [OLD_ORG, out.zone_old_org], [OLD_COM, out.zone_old_com]];
  for (const r of list) {
    const name = String(r.name).replace(/\.$/, '').toLowerCase();
    const z = zones.find(([d]) => name === d || name.endsWith('.' + d));
    if (!z || !z[1]) { warn(`dns ${name}: no zone in this account`); process.exitCode = 1; continue; }
    const type = String(r.type).toUpperCase();
    try { await dnsUpsert(z[1], type, name, String(r.content), ['A', 'AAAA', 'CNAME'].includes(type) ? { proxied: false } : {}); }
    catch (e) { warn(`dns ${name} ${type}: ${e.message}`); process.exitCode = 1; }
  }
}

/* ---------- summary ---------- */
function summary() {
  log('\n================ SUMMARY (commit the wrangler.toml values; nothing here is secret) ================');
  log(`CLOUDFLARE_ACCOUNT_ID = ${out.account_id || '?'}`);
  if (out.d1) for (const [b, v] of Object.entries(out.d1)) log(`${b}: database_id = "${v.id}"`);
  log(`ACCESS_TEAM_DOMAIN = "${out.access_team_domain || ''}"`);
  log(`ACCESS_AUD = "${out.access_aud || ''}"`);
  log(`mailbox ${out.mailbox || '?'}: ${out.mailbox_verified ? 'verified' : 'verify it, then re-run step "email"'}`);
  log('=====================================================================================================');
}

const run = { account, d1, subdomain, zone, ech, dns, email, redirects, ratelimit, access, pages, retire, records };
(async () => {
  if (!out.account_id || want('account')) await account();
  for (const step of ['d1', 'subdomain', 'zone', 'ech', 'dns', 'email', 'redirects', 'ratelimit', 'access', 'pages', 'retire', 'records']) {
    if (!want(step)) continue;
    log(`\n--- ${step} ---`);
    try { await run[step](); } catch (e) { warn(`${step} failed: ${e.message}`); process.exitCode = 1; }
  }
  summary();
})();
