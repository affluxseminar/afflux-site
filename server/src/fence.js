/* Key-generation fence (see migrations: table meta). Every encrypted write runs with
   `AND EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)` — writers on a stale key
   generation write nothing and get E_KEY_GENERATION (a 503, "try again"). The fence advances
   automatically along the configured previous → current chain, so a rotation is: deploy with
   NEW + PREVIOUS (first request activates NEW; old-generation requests are fenced out from that
   moment), migrate until the counters are 0, remove PREVIOUS. */
import { currentKeyId, indexKeyPrefix, previousKeyId, previousIndexKeyPrefix } from './crypto.js';

export const FENCE_SQL = "EXISTS (SELECT 1 FROM meta WHERE key = ? AND value = ?)";

async function advance(db, key, current, previous) {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  if (!row) { await db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').bind(key, current).run(); }
  else if (row.value !== current) {
    if (previous && row.value === previous) await db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').bind(current, key, previous).run();
  }
  const now = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return now && now.value === current;
}

/* Returns the fence parameters for this writer, or throws E_KEY_GENERATION. Call once per write path. */
export async function dataFence(env, db) {
  const current = await currentKeyId(env);
  const ok = await advance(db, 'data_key_fp', current, await previousKeyId(env));
  if (!ok) { const e = new Error('stale key generation'); e.code = 'E_KEY_GENERATION'; e.status = 503; throw e; }
  return ['data_key_fp', current];
}
export async function indexFence(env, db) {
  const current = (await indexKeyPrefix(env)).replace(/\.$/, '');
  const prev = env.INDEX_KEY_PREVIOUS ? (await previousIndexKeyPrefix(env)).replace(/\.$/, '') : null;
  const ok = await advance(db, 'index_key_fp', current, prev);
  if (!ok) { const e = new Error('stale index key generation'); e.code = 'E_KEY_GENERATION'; e.status = 503; throw e; }
  return ['index_key_fp', current];
}
export function fenced(meta) {
  // meta = result of a write statement; a fenced write that matched nothing means the generation moved on
  if (!meta || meta.changes !== 1) { const e = new Error('write refused by key fence'); e.code = 'E_KEY_GENERATION'; e.status = 503; throw e; }
}
