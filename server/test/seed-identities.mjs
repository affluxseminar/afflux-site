/* Writes an SQL file that inserts N synthetic identities + profiles encrypted with the keys in
   .dev.vars.dev (the "old" keys for a rotation rehearsal). Usage: node test/seed-identities.mjs 600 /tmp/seed-identity.sql /tmp/seed-users.sql */
import { readFileSync, writeFileSync } from 'node:fs';
import { indexKey, encryptField, randomId } from '../src/crypto.js';
const [n, outIdent, outUsers] = [Number(process.argv[2] || 600), process.argv[3], process.argv[4]];
const env = Object.fromEntries(readFileSync(new URL('../.dev.vars.dev', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split('=')));
const now = new Date().toISOString();
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ident = [], users = [];
for (let i = 0; i < n; i++) {
  const id = randomId('u_'); const email = `seed${i}@example.org`;
  ident.push(`(${q(id)}, ${q(await indexKey(env, email, 'current'))}, ${q(await encryptField(env, email, `identities:${id}:email`))}, 'active', ${q(now)}, ${q(now)})`);
  users.push(`(${q(id)}, ${q(await encryptField(env, `Seed Person ${i}`, `users:${id}:name`))}, NULL, ${i % 2}, ${(i + 1) % 2}, ${q(now)}, ${q(now)})`);
}
const chunk = (arr, head) => { let s = ''; for (let i = 0; i < arr.length; i += 100) s += `${head} VALUES ${arr.slice(i, i + 100).join(',')};\n`; return s; };
writeFileSync(outIdent, chunk(ident, 'INSERT INTO identities (id, email_key, email_enc, status, created_at, verified_at)'));
writeFileSync(outUsers, chunk(users, 'INSERT INTO users (auth_user_id, name_enc, affiliation_enc, pref_ru, pref_en, created_at, updated_at)'));
console.log(`seeded ${n}`);
