/* Local stand-in for SMTP2GO so the whole flow can be exercised offline.
   node test/mock-services.mjs  → :9101. Every message is kept in an outbox; the last sign-in
   link is exposed at GET /_last_link; GET /_outbox lists messages; GET /_reset clears. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/* And a stand-in for the GitHub Contents API (the content repository): an in-memory map of
   path → { content (base64), sha }. GET /_repo lists it; /_reset clears it with the outbox. */
const repo = new Map();
const shaOf = (b64) => createHash('sha1').update(b64).digest('hex');

const outbox = [];
let lastLink = null;
let delayMs = 0;
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); });

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/_outbox') return json(res, 200, outbox);
  if (u.pathname === '/_last_link') return json(res, 200, { link: lastLink });
  if (u.pathname === '/_reset') { outbox.length = 0; lastLink = null; delayMs = 0; repo.clear(); return json(res, 200, {}); }
  if (u.pathname === '/_repo') return json(res, 200, [...repo.entries()].map(([path, v]) => ({ path, sha: v.sha, size: Buffer.from(v.content, 'base64').length, text: path.endsWith('.json') ? Buffer.from(v.content, 'base64').toString('utf8') : null })));
  const gh = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (gh) {
    if (req.headers.authorization !== 'Bearer github-test-local') return json(res, 401, { message: 'Bad credentials' });
    const path = decodeURIComponent(gh[1]).replace(/\/$/, '');
    if (req.method === 'GET') {
      const f = repo.get(path);
      if (f) return json(res, 200, { type: 'file', path, sha: f.sha, encoding: 'base64', content: f.content, size: Buffer.from(f.content, 'base64').length });
      const dir = [...repo.entries()].filter(([p]) => p.startsWith(path + '/')).map(([p, v]) => ({ type: 'file', name: p.slice(path.length + 1), path: p, sha: v.sha, size: Buffer.from(v.content, 'base64').length })).filter((x) => !x.name.includes('/'));
      return dir.length ? json(res, 200, dir) : json(res, 404, { message: 'Not Found' });
    }
    const body = await readBody(req);
    if (req.method === 'PUT') {
      const cur = repo.get(path);
      if (cur && body.sha !== cur.sha) return json(res, 409, { message: 'sha does not match' });
      if (!cur && body.sha) return json(res, 422, { message: 'sha given for a new file' });
      if (typeof body.content !== 'string') return json(res, 422, { message: 'content missing' });
      const sha = shaOf(body.content); repo.set(path, { content: body.content, sha });
      return json(res, cur ? 200 : 201, { content: { path, sha }, commit: { message: body.message } });
    }
    if (req.method === 'DELETE') {
      const cur = repo.get(path);
      if (!cur) return json(res, 404, { message: 'Not Found' });
      if (body.sha !== cur.sha) return json(res, 409, { message: 'sha does not match' });
      repo.delete(path); return json(res, 200, { commit: { message: body.message } });
    }
    return json(res, 405, {});
  }
  if (u.pathname === '/_delay') { delayMs = Number(u.searchParams.get('ms') || 0); return json(res, 200, { delayMs }); }
  if (u.pathname === '/v3/email/send' && req.method === 'POST') {
    if (req.headers['x-smtp2go-api-key'] !== 'api-test-local') return json(res, 401, { data: { error: 'bad key' } });
    const m = await readBody(req);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    outbox.push(m);
    const link = (m.text_body || '').match(/https?:\/\/\S+account\/verify\?token=\S+/);
    if (link) { lastLink = link[0]; console.log('LINK', m.to[0], lastLink); }
    return json(res, 200, { request_id: 'r', data: { succeeded: 1, failed: 0, email_id: 'e' } });
  }
  json(res, 404, {});
}).listen(9101, () => console.log('mock smtp2go :9101'));
