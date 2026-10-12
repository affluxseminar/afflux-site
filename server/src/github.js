/* The programme lives in the content repository on GitHub; the admin's talk editor writes it there
   through the Contents API with a fine-grained token limited to that one repository (Contents:
   read/write). The token is a Worker secret; nothing of it reaches the browser. */

const base = (env) => (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const repo = (env) => String(env.CONTENT_REPO || '');
const branch = (env) => String(env.CONTENT_BRANCH || 'main');

function configured(env) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo(env)) && !!env.GITHUB_CONTENT_TOKEN; }

async function call(env, method, path, body) {
  if (!configured(env)) { const e = new Error('content repository not configured'); e.code = 'E_CONTENT_CONFIG'; throw e; }
  const res = await fetch(`${base(env)}/repos/${repo(env)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${method === 'GET' ? `?ref=${encodeURIComponent(branch(env))}` : ''}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${env.GITHUB_CONTENT_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'afflux-server',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404 && method === 'GET') return null;
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const e = new Error(`github ${res.status}`);
    e.code = res.status === 401 || res.status === 403 ? 'E_CONTENT_AUTH' : (res.status === 409 || res.status === 422 ? 'E_CONTENT_CONFLICT' : 'E_CONTENT');
    e.status = res.status;
    e.detail = data && data.message ? String(data.message).slice(0, 200) : '';
    throw e;
  }
  return data;
}

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(String(s).replace(/\n/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

export const content = {
  configured,
  /* Text file → { text, sha } or null. */
  async getText(env, path) {
    const d = await call(env, 'GET', path);
    if (!d || Array.isArray(d) || d.type !== 'file') return null;
    return { text: new TextDecoder().decode(unb64(d.content || '')), sha: d.sha };
  },
  /* Directory listing → [{ name, sha, size }] (empty when the directory does not exist yet). */
  async list(env, path) {
    const d = await call(env, 'GET', path);
    if (!d || !Array.isArray(d)) return [];
    return d.filter((x) => x.type === 'file').map((x) => ({ name: x.name, sha: x.sha, size: x.size }));
  },
  /* Create or update. `sha` is required to update an existing file (the API refuses otherwise:
     a stale sha means someone else changed it meanwhile → E_CONTENT_CONFLICT). */
  async put(env, path, bytesOrText, message, sha) {
    const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
    const body = { message, content: b64(bytes), branch: branch(env) };
    if (sha) body.sha = sha;
    const d = await call(env, 'PUT', path, body);
    return d && d.content ? d.content.sha : null;
  },
  async remove(env, path, message, sha) {
    await call(env, 'DELETE', path, { message, sha, branch: branch(env) });
  }
};
