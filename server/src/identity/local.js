/* Identity: our own magic links and sessions on Cloudflare. The only file that touches IDENTITY_DB.
   Addresses are stored encrypted and indexed by a versioned keyed hash; tokens and sessions as
   hashes of 256-bit random values; links are single use, expire, and remember the browser that
   asked for them. */
import { randomToken, randomId, sha256, indexKey, indexKeyPrefix, encryptField, decryptField, currentKeyId } from '../crypto.js';
import { dataFence, indexFence, fenced, FENCE_SQL } from '../fence.js';

const now = () => new Date().toISOString();
const plus = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const normalise = (email) => String(email).trim().toLowerCase();
const ABSOLUTE_SESSION_DAYS = 365;

export function createIdentity(env, mail) {
  const db = env.IDENTITY_DB;
  const site = (env.SITE_BASE || '').replace(/\/$/, '');
  const aad = (id) => `identities:${id}:email`;

  /* Lookup under the current index key; during a migration also under the previous key (and the
     version-1 unprefixed format), re-keying the row on a hit. */
  async function findByEmail(email) {
    const e = normalise(email);
    const key = await indexKey(env, e, 'current');
    let row = await db.prepare('SELECT id, status FROM identities WHERE email_key = ?').bind(key).first();
    if (!row && env.INDEX_KEY_PREVIOUS) {
      for (const which of ['previous', 'legacy']) {
        const old = await indexKey(env, e, which);
        row = await db.prepare('SELECT id, status FROM identities WHERE email_key = ?').bind(old).first();
        if (row) { const [ik, iv] = await indexFence(env, db); await db.prepare(`UPDATE identities SET email_key = ? WHERE id = ? AND email_key = ? AND ${FENCE_SQL}`).bind(key, row.id, old, ik, iv).run(); break; }
      }
    }
    return { key, row };
  }
  async function emailOf(id) {
    const row = await db.prepare('SELECT email_enc, status FROM identities WHERE id = ?').bind(id).first();
    if (!row) return null;
    return { status: row.status, email: await decryptField(env, row.email_enc, aad(id)) };
  }
  const mask = (email) => {
    const [u, d] = String(email).split('@');
    return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
  };

  return {
    async sendLink({ email, lang, initNonce }) {
      const { key, row } = await findByEmail(email);
      let id = row && row.id, created = false;
      if (!id) {
        id = randomId('u_'); created = true;
        const [dk, dv] = await dataFence(env, db); const [ik, iv] = await indexFence(env, db);
        const r = await db.prepare(`INSERT INTO identities (id, email_key, email_enc, status, created_at) SELECT ?, ?, ?, ?, ? WHERE ${FENCE_SQL} AND ${FENCE_SQL}`)
          .bind(id, key, await encryptField(env, normalise(email), aad(id)), 'pending', now(), dk, dv, ik, iv).run();
        fenced(r.meta);
      }
      const purpose = row && row.status === 'active' ? 'login' : 'signup';
      const minutes = purpose === 'login' ? Number(env.LOGIN_LINK_MINUTES || 20) : Number(env.SIGNUP_LINK_HOURS || 24) * 60;
      const token = randomToken(32);
      await db.prepare('INSERT INTO tokens (hash, identity_id, purpose, init_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256(token), id, purpose, initNonce ? await sha256(initNonce) : null, plus(minutes)).run();
      const link = `${site}${lang === 'ru' ? '/ru' : ''}/account/verify?token=${token}`;
      await mail.sendLink({ to: normalise(email), link, lang, purpose, minutes });
      return { userId: id, created };
    },

    /* Describes a token by its hash without consuming it: whose account, same browser? */
    async inspectLink({ hash, initNonce }) {
      const t = await db.prepare('SELECT identity_id, init_hash, expires_at, used_at FROM tokens WHERE hash = ?').bind(hash).first();
      if (!t || t.used_at || t.expires_at < now()) return null;
      const who = await emailOf(t.identity_id);
      if (!who) return null;
      const same = !!(t.init_hash && initNonce && t.init_hash === await sha256(initNonce));
      return { identityId: t.identity_id, masked: mask(who.email), sameBrowser: same, bound: !!t.init_hash };
    },

    /* Consumes a token (by hash) and opens a session: one conditional claim; one winner. */
    async authenticateLink({ hash }) {
      // Expiry is compared with the database's own clock at execution time, not a timestamp prepared earlier.
      const claimed = await db.prepare("UPDATE tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").bind(now(), hash).run();
      if (!claimed.meta || claimed.meta.changes !== 1) { const e = new Error('token invalid'); e.status = 401; throw e; }
      const t = await db.prepare('SELECT identity_id FROM tokens WHERE hash = ?').bind(hash).first();
      await db.prepare("UPDATE identities SET status = 'active', verified_at = COALESCE(verified_at, ?) WHERE id = ?").bind(now(), t.identity_id).run();
      const sessionToken = randomToken(32);
      await db.prepare('INSERT INTO sessions (hash, identity_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await sha256(sessionToken), t.identity_id, now(), plus(Number(env.SESSION_MINUTES || 129600)), now()).run();
      return { userId: t.identity_id, sessionToken, status: 'active' };
    },

    async authenticateSession(sessionToken) {
      if (!sessionToken) return null;
      const h = await sha256(sessionToken);
      const s = await db.prepare('SELECT s.identity_id, s.created_at, s.expires_at, s.seen_at, s.revoked_at, i.status FROM sessions s JOIN identities i ON i.id = s.identity_id WHERE s.hash = ?').bind(h).first();
      if (!s || s.revoked_at || s.expires_at < now() || s.status !== 'active') return null;
      if (Date.now() - Date.parse(s.created_at) > ABSOLUTE_SESSION_DAYS * 86400e3) return null;
      let slid = false;
      if (Date.now() - Date.parse(s.seen_at) > 3600e3) {
        await db.prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE hash = ?').bind(now(), plus(Number(env.SESSION_MINUTES || 129600)), h).run();
        slid = true;
      }
      return { userId: s.identity_id, sessionToken, slid };
    },

    async revokeSession(sessionToken) {
      if (sessionToken) await db.prepare('UPDATE sessions SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL').bind(now(), await sha256(sessionToken)).run();
    },
    async revokeAllSessions(userId) {
      await db.prepare('UPDATE sessions SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL').bind(now(), userId).run();
    },
    async revokeEverySession() {
      await db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').bind(now()).run();
    },

    async getUser(userId) { return emailOf(userId); },

    async getEmails(userIds) {
      const out = new Map();
      for (let i = 0; i < userIds.length; i += 50) {
        const chunk = userIds.slice(i, i + 50);
        const r = await db.prepare(`SELECT id, email_enc FROM identities WHERE status = 'active' AND id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
        for (const row of r.results || []) out.set(row.id, await decryptField(env, row.email_enc, aad(row.id)));
      }
      return out;
    },

    async deleteUser(userId) {
      await db.batch([
        db.prepare('DELETE FROM sessions WHERE identity_id = ?').bind(userId),
        db.prepare('DELETE FROM tokens WHERE identity_id = ?').bind(userId),
        db.prepare('DELETE FROM identities WHERE id = ?').bind(userId)
      ]);
    },

    async housekeeping() {
      const cutoff = new Date(Date.now() - Number(env.PENDING_HOURS || 24) * 3600e3).toISOString();
      const stale = await db.prepare("SELECT id FROM identities WHERE status = 'pending' AND created_at < ?").bind(cutoff).all();
      for (const row of stale.results || []) await this.deleteUser(row.id);
      await db.batch([
        db.prepare('DELETE FROM tokens WHERE expires_at < ? OR used_at IS NOT NULL').bind(now()),
        db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(now())
      ]);
      return (stale.results || []).map((r) => r.id);
    },

    /* Key migrations, run from the admin in bounded passes until "remaining" is 0.
       Each pass selects rows that are still on another key, so completion is exact, not inferred;
       every write is compare-and-swap against the value that was read, so a concurrent change is
       never overwritten (the row is simply picked up by the next pass). */
    async migrationStatus() {
      const fenceRows = (await db.prepare("SELECT key, value FROM meta").all()).results || [];
      const prefix = await indexKeyPrefix(env);
      const idx = await db.prepare('SELECT COUNT(*) AS n FROM identities WHERE substr(email_key, 1, ?) != ?').bind(prefix.length, prefix).first();
      const cur = await currentKeyId(env);
      const enc_ = await db.prepare('SELECT COUNT(*) AS n FROM identities WHERE substr(email_enc, 1, ?) != ?').bind(cur.length + 1, cur + '.').first();
      return { indexRemaining: idx.n, encryptionRemaining: enc_.n, fence: Object.fromEntries(fenceRows.map((r) => [r.key, r.value])), current: { data: cur, index: prefix.replace(/\.$/, '') } };
    },
    async reindex(limit = 100) {
      const prefix = await indexKeyPrefix(env);
      const rows = (await db.prepare('SELECT id, email_enc, email_key FROM identities WHERE substr(email_key, 1, ?) != ? LIMIT ?').bind(prefix.length, prefix, limit).all()).results || [];
      let changed = 0;
      for (const r of rows) {
        const email = await decryptField(env, r.email_enc, aad(r.id));
        const key = await indexKey(env, email, 'current');
        const [ik, iv] = await indexFence(env, db);
        const u = await db.prepare(`UPDATE identities SET email_key = ? WHERE id = ? AND email_key = ? AND ${FENCE_SQL}`).bind(key, r.id, r.email_key, ik, iv).run();
        if (u.meta && u.meta.changes === 1) changed++;
      }
      return changed;
    },
    async reencrypt(limit = 100) {
      const cur = await currentKeyId(env);
      const rows = (await db.prepare('SELECT id, email_enc FROM identities WHERE substr(email_enc, 1, ?) != ? LIMIT ?').bind(cur.length + 1, cur + '.', limit).all()).results || [];
      let changed = 0;
      for (const r of rows) {
        const email = await decryptField(env, r.email_enc, aad(r.id));
        const [dk, dv] = await dataFence(env, db);
        const u = await db.prepare(`UPDATE identities SET email_enc = ? WHERE id = ? AND email_enc = ? AND ${FENCE_SQL}`).bind(await encryptField(env, email, aad(r.id)), r.id, r.email_enc, dk, dv).run();
        if (u.meta && u.meta.changes === 1) changed++;
      }
      return changed;
    }
  };
}
