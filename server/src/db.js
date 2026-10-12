/* Data access for the application database (users, pending profiles, throttle, send jobs).
   Name, affiliation, announcement subject and body are encrypted at rest; this module hides that.
   Key migrations here select rows still on another key and write compare-and-swap. */
import { encryptField, decryptField, randomId, currentKeyId } from './crypto.js';
import { dataFence, fenced, FENCE_SQL } from './fence.js';

const now = () => new Date().toISOString();
const aad = (table, id, field) => `${table}:${id}:${field}`;

async function decodeUser(env, row, table = 'users') {
  if (!row) return null;
  return {
    auth_user_id: row.auth_user_id,
    name: (await decryptField(env, row.name_enc, aad(table, row.auth_user_id, 'name'))) || '',
    affiliation: (await decryptField(env, row.affiliation_enc, aad(table, row.auth_user_id, 'affiliation'))) || '',
    pref_ru: !!row.pref_ru, pref_en: !!row.pref_en,
    created_at: row.created_at, updated_at: row.updated_at, expires_at: row.expires_at
  };
}
async function encode(env, table, id, u) {
  return {
    name_enc: await encryptField(env, u.name, aad(table, id, 'name')),
    affiliation_enc: await encryptField(env, u.affiliation, aad(table, id, 'affiliation'))
  };
}
// fingerprints are base64url and may contain '_' — never a LIKE pattern; compare a prefix with substr
const notCurrent = (col, cur) => `(${col} IS NOT NULL AND substr(${col}, 1, ${cur.length + 1}) != '${cur}.')`;

export const users = {
  get: async (env, id) => decodeUser(env, await env.USERS_DB.prepare('SELECT * FROM users WHERE auth_user_id = ?').bind(id).first()),
  create: async (env, u) => {
    const e = await encode(env, 'users', u.auth_user_id, u);
    const [fk, fv] = await dataFence(env, env.USERS_DB);
    const r = await env.USERS_DB.prepare(`INSERT INTO users (auth_user_id, name_enc, affiliation_enc, pref_ru, pref_en, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${FENCE_SQL}`)
      .bind(u.auth_user_id, e.name_enc, e.affiliation_enc, u.pref_ru ? 1 : 0, u.pref_en ? 1 : 0, now(), now(), fk, fv).run();
    fenced(r.meta);
  },
  update: async (env, id, u) => {
    const e = await encode(env, 'users', id, u);
    const [fk, fv] = await dataFence(env, env.USERS_DB);
    const r = await env.USERS_DB.prepare(`UPDATE users SET name_enc = ?, affiliation_enc = ?, pref_ru = ?, pref_en = ?, updated_at = ? WHERE auth_user_id = ? AND ${FENCE_SQL}`)
      .bind(e.name_enc, e.affiliation_enc, u.pref_ru ? 1 : 0, u.pref_en ? 1 : 0, now(), id, fk, fv).run();
    fenced(r.meta);
  },
  setPref: (env, id, list, on) => env.USERS_DB.prepare(`UPDATE users SET ${list === 'ru' ? 'pref_ru' : 'pref_en'} = ?, updated_at = ? WHERE auth_user_id = ?`).bind(on ? 1 : 0, now(), id).run(),
  hasPref: async (env, id, list) => {
    const r = await env.USERS_DB.prepare(`SELECT ${list === 'ru' ? 'pref_ru' : 'pref_en'} AS on_ FROM users WHERE auth_user_id = ?`).bind(id).first();
    return !!(r && r.on_);
  },
  prefsFor: async (env, ids, list) => {
    if (!ids.length) return new Set();
    const r = await env.USERS_DB.prepare(`SELECT auth_user_id FROM users WHERE ${list === 'ru' ? 'pref_ru' : 'pref_en'} = 1 AND auth_user_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    return new Set((r.results || []).map((x) => x.auth_user_id));
  },
  remove: (env, id) => env.USERS_DB.prepare('DELETE FROM users WHERE auth_user_id = ?').bind(id).run(),
  idsForList: async (env, list) => ((await env.USERS_DB.prepare(`SELECT auth_user_id FROM users WHERE ${list === 'ru' ? 'pref_ru' : 'pref_en'} = 1 ORDER BY created_at`).all()).results || []).map((x) => x.auth_user_id),
  counts: async (env) => {
    const r = await env.USERS_DB.prepare('SELECT COUNT(*) AS total, SUM(pref_ru) AS ru, SUM(pref_en) AS en FROM users').first();
    const p = await env.USERS_DB.prepare('SELECT COUNT(*) AS pending FROM pending_profiles').first();
    return { total: r.total || 0, ru: r.ru || 0, en: r.en || 0, pending: p.pending || 0 };
  },
  migrationStatus: async (env) => {
    const cur = await currentKeyId(env);
    let n = 0;
    for (const t of ['users', 'pending_profiles']) {
      const r = await env.USERS_DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${notCurrent('name_enc', cur)} OR ${notCurrent('affiliation_enc', cur)}`).first();
      n += r.n;
    }
    return n;
  },
  reencrypt: async (env, limit = 100) => {
    const cur = await currentKeyId(env);
    let changed = 0;
    for (const table of ['users', 'pending_profiles']) {
      const rows = (await env.USERS_DB.prepare(`SELECT * FROM ${table} WHERE ${notCurrent('name_enc', cur)} OR ${notCurrent('affiliation_enc', cur)} LIMIT ?`).bind(limit - changed).all()).results || [];
      for (const r of rows) {
        const u = await decodeUser(env, r, table === 'users' ? 'users' : 'pending');
        const e = await encode(env, table === 'users' ? 'users' : 'pending', r.auth_user_id, u);
        const [fk, fv] = await dataFence(env, env.USERS_DB);
        const w = await env.USERS_DB.prepare(`UPDATE ${table} SET name_enc = ?, affiliation_enc = ? WHERE auth_user_id = ? AND name_enc = ? AND affiliation_enc IS ? AND ${FENCE_SQL}`).bind(e.name_enc, e.affiliation_enc, r.auth_user_id, r.name_enc, r.affiliation_enc, fk, fv).run();
        if (w.meta && w.meta.changes === 1) changed++;
      }
      if (changed >= limit) break;
    }
    return changed;
  }
};

export const pending = {
  put: async (env, p, hours) => {
    const e = await encode(env, 'pending', p.auth_user_id, p);
    const [fk, fv] = await dataFence(env, env.USERS_DB);
    const r = await env.USERS_DB.prepare(`INSERT OR REPLACE INTO pending_profiles (auth_user_id, name_enc, affiliation_enc, pref_ru, pref_en, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${FENCE_SQL}`)
      .bind(p.auth_user_id, e.name_enc, e.affiliation_enc, p.pref_ru ? 1 : 0, p.pref_en ? 1 : 0, now(), new Date(Date.now() + hours * 3600e3).toISOString(), fk, fv).run();
    fenced(r.meta);
  },
  take: async (env, id) => {
    const row = await env.USERS_DB.prepare('SELECT * FROM pending_profiles WHERE auth_user_id = ?').bind(id).first();
    if (row) await env.USERS_DB.prepare('DELETE FROM pending_profiles WHERE auth_user_id = ?').bind(id).run();
    return decodeUser(env, row, 'pending');
  },
  expired: async (env) => ((await env.USERS_DB.prepare('SELECT auth_user_id FROM pending_profiles WHERE expires_at < ?').bind(now()).all()).results || []).map((x) => x.auth_user_id),
  remove: (env, id) => env.USERS_DB.prepare('DELETE FROM pending_profiles WHERE auth_user_id = ?').bind(id).run()
};

export const throttle = {
  hit: async (env, key, limit, windowSec) => {
    const t = Math.floor(Date.now() / 1000);
    const r = await env.USERS_DB.prepare(`INSERT INTO throttle (key, hits, window_start) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        hits = CASE WHEN throttle.window_start + ? < ? THEN 1 ELSE throttle.hits + 1 END,
        window_start = CASE WHEN throttle.window_start + ? < ? THEN ? ELSE throttle.window_start END
      RETURNING hits`).bind(key, t, windowSec, t, windowSec, t, t).first();
    return !!r && r.hits <= limit;
  },
  purge: (env) => env.USERS_DB.prepare('DELETE FROM throttle WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 3600).run()
};

export const sends = {
  /* Job creation is idempotent and resumable: the job row is inserted (or found) under the
     idempotency key in state `initializing`, the recipient rows are added in batches (INSERT OR
     IGNORE, so a retry completes a partial set), and only when every intended recipient is durable
     does the job become `running`. A key reused with a different payload is refused. */
  create: async (env, { idemKey, list, subject, body, targets }) => {
    const id = randomId('s_');
    const [fk, fv] = await dataFence(env, env.USERS_DB);
    await env.USERS_DB.prepare(`INSERT OR IGNORE INTO sends (id, idem_key, list, subject_enc, body_enc, status, intended, targets, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${FENCE_SQL}`)
      .bind(id, idemKey, list, await encryptField(env, subject, aad('sends', id, 'subject')), await encryptField(env, body, aad('sends', id, 'body')), 'initializing', targets.length, JSON.stringify(targets), now(), fk, fv).run();
    const job = await env.USERS_DB.prepare('SELECT id, list, subject_enc, body_enc, status, targets FROM sends WHERE idem_key = ?').bind(idemKey).first();
    if (!job) { const e = new Error('write refused by key fence'); e.code = 'E_KEY_GENERATION'; e.status = 503; throw e; }
    // A key may only be reused for the same announcement: compare after authorised decryption, no stored hash.
    const same = job.list === list
      && (await decryptField(env, job.subject_enc, aad('sends', job.id, 'subject'))) === subject
      && (await decryptField(env, job.body_enc, aad('sends', job.id, 'body'))) === body;
    if (!same) { const e = new Error('idempotency key reused with a different payload'); e.status = 409; throw e; }
    if (job.status === 'initializing') {
      const snapshot = JSON.parse(job.targets);           // resume from the set the job was created for, not from today's list
      for (let i = 0; i < snapshot.length; i += 50) {
        await env.USERS_DB.batch(snapshot.slice(i, i + 50).map((uid) =>
          env.USERS_DB.prepare('INSERT OR IGNORE INTO send_targets (send_id, auth_user_id, state, updated_at) VALUES (?, ?, ?, ?)').bind(job.id, uid, 'pending', now())));
      }
      const have = await env.USERS_DB.prepare('SELECT COUNT(*) AS n FROM send_targets WHERE send_id = ?').bind(job.id).first();
      if (have.n >= snapshot.length) {
        await env.USERS_DB.prepare("UPDATE sends SET status = ? WHERE id = ? AND status = 'initializing'").bind(snapshot.length ? 'running' : 'done', job.id).run();
      }
    }
    return job.id;
  },
  get: async (env, id) => {
    const r = await env.USERS_DB.prepare('SELECT * FROM sends WHERE id = ?').bind(id).first();
    if (!r) return null;
    r.subject = await decryptField(env, r.subject_enc, aad('sends', id, 'subject'));
    r.body = await decryptField(env, r.body_enc, aad('sends', id, 'body'));
    const c = (await env.USERS_DB.prepare('SELECT state, COUNT(*) AS n FROM send_targets WHERE send_id = ? GROUP BY state').bind(id).all()).results || [];
    r.counts = { pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
    for (const x of c) r.counts[x.state] = x.n;
    r.total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    return r;
  },
  start: (env, id) => env.USERS_DB.prepare("UPDATE sends SET started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'running'").bind(now(), id).run(),
  /* Atomically claims up to `limit` pending recipients for this request under a fresh attempt id;
     a claim older than 15 minutes (a worker that died mid-send) becomes `unknown` and is never retried
     by itself. Completion updates must carry the attempt id that claimed the row. */
  claim: async (env, id, limit) => {
    const stale = new Date(Date.now() - 15 * 60000).toISOString();
    const attempt = randomId('a_');
    await env.USERS_DB.prepare("UPDATE send_targets SET state = 'unknown', attempt_id = NULL, updated_at = ? WHERE send_id = ? AND state = 'sending' AND claimed_at < ?").bind(now(), id, stale).run();
    const r = await env.USERS_DB.prepare(`UPDATE send_targets SET state = 'sending', attempt_id = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE send_id = ? AND state = 'pending' AND auth_user_id IN (SELECT auth_user_id FROM send_targets WHERE send_id = ? AND state = 'pending' LIMIT ?)
      RETURNING auth_user_id`).bind(attempt, now(), now(), id, id, limit).all();
    return { attempt, ids: (r.results || []).map((x) => x.auth_user_id) };
  },
  markMany: async (env, id, attempt, outcomes) => {
    if (!outcomes.length) return;
    await env.USERS_DB.batch(outcomes.map(([uid, state]) =>
      env.USERS_DB.prepare("UPDATE send_targets SET state = ?, attempt_id = NULL, updated_at = ? WHERE send_id = ? AND auth_user_id = ? AND state = 'sending' AND attempt_id = ?").bind(state, now(), id, uid, attempt)));
  },
  /* Completion is one statement whose condition is evaluated at execution time: a retry that has
     just put targets back to `pending` cannot be overtaken by a stale completion. */
  finishIfDone: async (env, id) => {
    const r = await env.USERS_DB.prepare("UPDATE sends SET status = 'done', finished_at = ? WHERE id = ? AND status = 'running' AND NOT EXISTS (SELECT 1 FROM send_targets WHERE send_id = ? AND state IN ('pending', 'sending'))").bind(now(), id, id).run();
    return !!(r.meta && r.meta.changes === 1);
  },
  /* Targets first, then the parent: between the two, a completion sees pending rows and does nothing. */
  retry: async (env, id, includeUnknown) => {
    await env.USERS_DB.prepare(`UPDATE send_targets SET state = 'pending', attempt_id = NULL, updated_at = ? WHERE send_id = ? AND state IN ('failed'${includeUnknown ? ", 'unknown'" : ''})`).bind(now(), id).run();
    await env.USERS_DB.prepare("UPDATE sends SET status = 'running', finished_at = NULL WHERE id = ? AND status = 'done' AND EXISTS (SELECT 1 FROM send_targets WHERE send_id = ? AND state = 'pending')").bind(id, id).run();
  },
  recent: async (env) => {
    const rows = (await env.USERS_DB.prepare('SELECT id, list, status, created_at, subject_enc FROM sends ORDER BY created_at DESC LIMIT 20').all()).results || [];
    for (const r of rows) {
      r.subject = await decryptField(env, r.subject_enc, aad('sends', r.id, 'subject'));
      const c = await env.USERS_DB.prepare("SELECT SUM(state = 'sent') AS sent, COUNT(*) AS total FROM send_targets WHERE send_id = ?").bind(r.id).first();
      r.sent = c.sent || 0; r.total = c.total || 0;
    }
    return rows;
  },
  migrationStatus: async (env) => {
    const cur = await currentKeyId(env);
    return (await env.USERS_DB.prepare(`SELECT COUNT(*) AS n FROM sends WHERE ${notCurrent('subject_enc', cur)} OR ${notCurrent('body_enc', cur)}`).first()).n;
  },
  reencrypt: async (env, limit = 100) => {
    const cur = await currentKeyId(env);
    const rows = (await env.USERS_DB.prepare(`SELECT id, subject_enc, body_enc FROM sends WHERE ${notCurrent('subject_enc', cur)} OR ${notCurrent('body_enc', cur)} LIMIT ?`).bind(limit).all()).results || [];
    let changed = 0;
    for (const r of rows) {
      const subject = await decryptField(env, r.subject_enc, aad('sends', r.id, 'subject'));
      const body = await decryptField(env, r.body_enc, aad('sends', r.id, 'body'));
      const [fk, fv] = await dataFence(env, env.USERS_DB);
      const w = await env.USERS_DB.prepare(`UPDATE sends SET subject_enc = ?, body_enc = ? WHERE id = ? AND subject_enc = ? AND body_enc = ? AND ${FENCE_SQL}`)
        .bind(await encryptField(env, subject, aad('sends', r.id, 'subject')), await encryptField(env, body, aad('sends', r.id, 'body')), r.id, r.subject_enc, r.body_enc, fk, fv).run();
      if (w.meta && w.meta.changes === 1) changed++;
    }
    return changed;
  }
};

export const links = {
  get: async (env, slug) => {
    const row = await env.LINKS_DB.prepare('SELECT * FROM links WHERE slug = ?').bind(slug).first();
    if (!row) return null;
    return { slug, zoom: await decryptField(env, row.zoom, aad('links', slug, 'zoom')), recording: await decryptField(env, row.recording, aad('links', slug, 'recording')), updated_at: row.updated_at };
  },
  all: async (env) => (await env.LINKS_DB.prepare('SELECT slug, zoom IS NOT NULL AS has_zoom, recording IS NOT NULL AS has_recording, updated_at FROM links ORDER BY updated_at DESC').all()).results || [],
  put: async (env, slug, zoom, recording) => {
    const [fk, fv] = await dataFence(env, env.LINKS_DB);
    const r = await env.LINKS_DB.prepare(`INSERT INTO links (slug, zoom, recording, updated_at) SELECT ?, ?, ?, ? WHERE ${FENCE_SQL} ON CONFLICT(slug) DO UPDATE SET zoom = excluded.zoom, recording = excluded.recording, updated_at = excluded.updated_at`)
      .bind(slug, await encryptField(env, zoom || '', aad('links', slug, 'zoom')), await encryptField(env, recording || '', aad('links', slug, 'recording')), now(), fk, fv).run();
    fenced(r.meta);
  },
  remove: (env, slug) => env.LINKS_DB.prepare('DELETE FROM links WHERE slug = ?').bind(slug).run(),
  migrationStatus: async (env) => {
    const cur = await currentKeyId(env);
    return (await env.LINKS_DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE ${notCurrent('zoom', cur)} OR ${notCurrent('recording', cur)}`).first()).n;
  },
  reencrypt: async (env, limit = 100) => {
    const cur = await currentKeyId(env);
    const rows = (await env.LINKS_DB.prepare(`SELECT * FROM links WHERE ${notCurrent('zoom', cur)} OR ${notCurrent('recording', cur)} LIMIT ?`).bind(limit).all()).results || [];
    let changed = 0;
    for (const r of rows) {
      const l = await links.get(env, r.slug);
      const [fk, fv] = await dataFence(env, env.LINKS_DB);
      const w = await env.LINKS_DB.prepare(`UPDATE links SET zoom = ?, recording = ?, updated_at = ? WHERE slug = ? AND zoom IS ? AND recording IS ? AND ${FENCE_SQL}`)
        .bind(await encryptField(env, l.zoom || '', aad('links', r.slug, 'zoom')), await encryptField(env, l.recording || '', aad('links', r.slug, 'recording')), now(), r.slug, r.zoom, r.recording, fk, fv).run();
      if (w.meta && w.meta.changes === 1) changed++;
    }
    return changed;
  }
};
