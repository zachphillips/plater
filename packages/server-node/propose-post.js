// /api/propose-post — the publishing-pipeline handoff into Plater.
//
// A draft arriving from an upstream publishing pipeline (a queue file whose
// source points at a markdown draft) can open HERE in a minimal edit surface
// for the owner's polish pass before they stage it. Deliberately small and
// real: load a draft file by path, edit it, save it back through Plater's
// existing git-commit save path (GitHub Contents API, same auth as /api/save).
// No social-posting UI, no scheduling, no publish button — the house rule is
// agents draft, the human edits, the human publishes. This surface only edits
// words.
//
//   GET  /api/propose-post?path=drafts/foo.md            → the edit view (HTML)
//   GET  /api/propose-post?path=drafts/foo.md&format=json → { path, content, sha }
//   POST /api/propose-post { path, content }             → commit via GitHub
//        (auth: Google ID token OR shared edit token — identical to /api/save)
//
// Config (env):
//   PLATER_DRAFTS_PREFIX  repo path prefix drafts must live under
//                         (default 'drafts/'; pipelines often use
//                         'publish-drafts/')
//   + the same GITHUB_REPOSITORY / GITHUB_BRANCH / auth env as save.js.
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || '').toLowerCase();
// Commits need a valid git identity even when the shared edit token (which
// carries no email) is the credential used.
const COMMIT_EMAIL = ADMIN_EMAIL || 'plater@users.noreply.github.com';
const SIGN_IN = ADMIN_EMAIL ? `sign in as ${ADMIN_EMAIL}` : 'sign in with the authorized account';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
// Normalize to exactly one trailing slash so the prefix is a true boundary
// ('drafts' and 'drafts/' both become 'drafts/'; a bare 'drafts' prefix would
// otherwise let 'draftsX/…' through).
const DRAFTS_PREFIX = (process.env.PLATER_DRAFTS_PREFIX || 'drafts/').replace(/^\/+|\/+$/g, '') + '/';
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const MAX_BODY = 2_000_000;
const FETCH_TIMEOUT_MS = Number(process.env.PLATER_FETCH_TIMEOUT_MS || 10_000);

// Bound every outbound request: a hung Google/GitHub call must not pin the
// handler or the client connection. Aborts surface as a caught rejection at
// the call site, mapped to a controlled auth/502 response.
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- auth (same contract as save.js / review.js) ------------ */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  // Fail CLOSED: with no CMS_ADMIN_EMAIL configured there is no one to
  // authorize, so an empty allowlist must never match an empty token email.
  if (!ADMIN_EMAIL) return { ok: false, reason: 'CMS_ADMIN_EMAIL is not set' };
  let r;
  try {
    r = await fetchWithTimeout('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  } catch {
    return { ok: false, reason: 'tokeninfo unreachable' };
  }
  if (!r.ok) return { ok: false, reason: 'tokeninfo ' + r.status };
  const t = await r.json();
  if (GOOGLE_CLIENT_ID && t.aud !== GOOGLE_CLIENT_ID) return { ok: false, reason: 'aud mismatch' };
  if (String(t.email_verified) !== 'true') return { ok: false, reason: 'email not verified' };
  if ((t.email || '').toLowerCase() !== ADMIN_EMAIL) return { ok: false, reason: 'not an admin' };
  if (t.exp && Math.floor(Date.now() / 1000) > Number(t.exp)) return { ok: false, reason: 'token expired' };
  return { ok: true, email: t.email };
}

async function verifyAuth(req) {
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!auth) return { ok: false, status: 401, reason: `${SIGN_IN} to save` };
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) return { ok: true, email: ADMIN_EMAIL };
  const verified = await verifyGoogle(auth);
  if (!verified.ok) return { ok: false, status: 401, reason: 'auth failed: ' + verified.reason };
  return { ok: true, email: verified.email };
}

/* ---------------- draft path safety --------------------------------------
   Only markdown drafts under the configured prefix are reachable — this is a
   handoff surface for pipeline drafts, not a general file editor. URL
   metacharacters (%, ?, #) and angle brackets are refused up front: a value
   like `drafts/%2e%2e/README.md` or `drafts/file?x=.md` would otherwise pass a
   naive check but get percent-decoded or query-truncated when spliced into a
   GitHub API URL, escaping the prefix / `.md` restriction. */
export function safeDraftPath(raw) {
  const p = String(raw || '').replace(/^\/+/, '');
  if (!p || /[%?#<>]/.test(p) || p.includes('..') || p.includes('\\') || !p.endsWith('.md')) return null;
  if (!p.startsWith(DRAFTS_PREFIX)) return null;
  return p;
}

// Encode each path segment for safe insertion into a GitHub Contents API URL
// while preserving the '/' boundaries. Belt-and-suspenders with safeDraftPath:
// even a sanctioned path is encoded so no character can alter the URL shape.
function encodeRepoPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/* ---------------- GitHub Contents API (the existing save path) ----------- */

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function readDraft(path) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token || !GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN / GITHUB_REPOSITORY' };
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  let r;
  try {
    r = await fetchWithTimeout(api, { headers: ghHeaders(token), cache: 'no-store' });
  } catch {
    return { ok: false, status: 502, error: 'github unreachable' };
  }
  if (r.status === 404) return { ok: false, status: 404, error: 'draft not found: ' + path };
  if (!r.ok) return { ok: false, status: 502, error: `github read ${r.status}` };
  const file = await r.json();
  return { ok: true, sha: file.sha, content: Buffer.from(file.content || '', 'base64').toString('utf8') };
}

// Optimistic concurrency: the editor sends back the blob SHA it loaded, and we
// commit against that exact SHA. If the draft moved underneath the editor,
// GitHub answers 409 and we report a conflict instead of clobbering the newer
// content. When no SHA is supplied (first write / create), fall back to a read
// so a brand-new draft still commits.
async function commitDraft(path, content, who, expectedSha) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token || !GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN / GITHUB_REPOSITORY' };
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${encodeRepoPath(path)}`;
  let sha = expectedSha || undefined;
  if (!sha) {
    let get;
    try {
      get = await fetchWithTimeout(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders(token), cache: 'no-store' });
    } catch {
      return { ok: false, status: 502, error: 'github unreachable' };
    }
    if (get.ok) sha = (await get.json()).sha;
    else if (get.status !== 404) return { ok: false, status: 502, error: `github read ${get.status}` };
  }
  let put;
  try {
    put = await fetchWithTimeout(api, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `draft(${SITE_NAME}): polish ${path} via propose-post by ${who}`,
        content: Buffer.from(String(content)).toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
        committer: { name: 'Plater CMS', email: COMMIT_EMAIL },
        author: { name: who || 'Plater CMS', email: who || COMMIT_EMAIL },
      }),
    });
  } catch {
    return { ok: false, status: 502, error: 'github unreachable' };
  }
  if (put.status === 409) return { ok: false, status: 409, error: 'conflict: draft changed since you loaded it — reload and reapply your edit' };
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  return { ok: true, sha: (await put.json()).commit?.sha };
}

/* ---------------- the minimal edit view ----------------------------------
   Plater edit-bar aesthetic (#1c1c1c bar, #c9a96e accent). One textarea, one
   save action; the words are the interface. Exported so the example
   dev-server can mount the same view against local files. */
export function editView(path) {
  // Escape '<' so a path containing '</script>' cannot break out of this inline
  // script context (JSON.stringify alone preserves '<', enabling reflected XSS
  // and theft of the edit token in localStorage). safeDraftPath already rejects
  // angle brackets, but editView is exported and must be self-defending.
  const p = JSON.stringify(path).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft — ${path.replace(/</g, '&lt;')}</title>
<style>
  body{margin:0;background:#161616;color:#e8e3d9;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;min-height:100vh}
  header{display:flex;align-items:baseline;gap:12px;padding:12px 18px;background:#1c1c1c;border-bottom:1px solid #2a2a2a;position:sticky;top:0}
  header b{font:700 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#c9a96e}
  header .path{font:12px/1 ui-monospace,Menlo,monospace;color:#8a8277;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header .law{margin-left:auto;font:10px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#6d665c}
  textarea{flex:1;width:100%;box-sizing:border-box;padding:26px clamp(18px,12vw,120px);background:#161616;color:#e8e3d9;border:0;outline:0;resize:none;font:15px/1.7 ui-monospace,Menlo,monospace}
  footer{display:flex;align-items:center;gap:12px;padding:10px 18px;background:#1c1c1c;border-top:1px solid #2a2a2a;position:sticky;bottom:0}
  button{background:#c9a96e;color:#151208;border:0;padding:8px 18px;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #status{font:12px/1.4 ui-monospace,Menlo,monospace;color:#8a8277}
  #status.err{color:#d47a6a} #status.ok{color:#7fae7f}
</style></head><body>
<header><b>Draft — your edit</b><span class="path">${path.replace(/</g, '&lt;')}</span><span class="law">agents draft · you edit · you publish</span></header>
<textarea id="t" spellcheck="true" placeholder="loading draft…" disabled></textarea>
<footer><button id="save" disabled>Save draft</button><span id="status">loading…</span></footer>
<script>
const PATH=${p};
const t=document.getElementById('t'),btn=document.getElementById('save'),st=document.getElementById('status');
const tokenKey='zms.'+location.hostname.replace(/[^a-z0-9]+/gi,'-').toLowerCase()+'.editToken';
let token='';try{token=localStorage.getItem(tokenKey)||''}catch{}
// share the site's Plater edit token if one is set under the brand key
if(!token){try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(/^zms\\..*\\.editToken$/.test(k)){token=localStorage.getItem(k)||'';break}}}catch{}}
let loadedSha='';
function status(msg,cls){st.textContent=msg;st.className=cls||''}
function promptToken(){token=window.prompt('Plater edit token')||'';if(token){try{localStorage.setItem(tokenKey,token)}catch{}}return token}
function authHeaders(){return token?{Authorization:'Bearer '+token}:{}}
async function fetchJson(path,opts){
  // authenticated draft content: attach the token if we have one, and on 401
  // prompt for it and retry once so unpublished drafts stay private.
  let r=await fetch(path,{...opts,headers:{...(opts&&opts.headers||{}),...authHeaders()}});
  if(r.status===401){if(!promptToken())return r;r=await fetch(path,{...opts,headers:{...(opts&&opts.headers||{}),...authHeaders()}})}
  return r;
}
async function load(){
  const r=await fetchJson('?path='+encodeURIComponent(PATH)+'&format=json',{cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){status(j.error||('load failed '+r.status),'err');return}
  t.value=j.content;loadedSha=j.sha||'';t.disabled=false;btn.disabled=false;status('loaded — make it yours');
}
btn.onclick=async()=>{
  if(!token&&!promptToken())return;
  btn.disabled=true;status('saving…');
  const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({path:PATH,content:t.value,sha:loadedSha})});
  const j=await r.json().catch(()=>({}));
  btn.disabled=false;
  if(!r.ok){if(r.status===401){try{localStorage.removeItem(tokenKey)}catch{};token=''}status(j.error||('save failed '+r.status),'err');return}
  status('saved — committed '+((j.git&&j.git.commit)||'').slice(0,7)+' · reload to keep editing','ok');
};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();btn.click()}});
load();
</script></body></html>`;
}

/* ---------------- handler ------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const path = safeDraftPath(url.searchParams.get('path'));
    if (!path) return res.status(400).json({ error: `expected ?path=${DRAFTS_PREFIX}<name>.md` });
    if (url.searchParams.get('format') === 'json') {
      // Draft content is unpublished — require the same admin auth as save,
      // otherwise anyone who guesses a path reads it via the server's token.
      const who = await verifyAuth(req);
      if (!who.ok) return res.status(who.status).json({ error: who.reason });
      const draft = await readDraft(path);
      if (!draft.ok) return res.status(draft.status || 500).json({ error: draft.error });
      return res.status(200).json({ path, content: draft.content, sha: draft.sha });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(editView(path));
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const who = await verifyAuth(req);
  if (!who.ok) return res.status(who.status).json({ error: who.reason });

  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_BODY) return res.status(413).json({ error: 'payload too large' });
  let payload;
  try {
    payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  // `JSON.parse('null')` (and 'true'/'42') parses fine but leaves a non-object
  // payload, so guard before dereferencing to avoid a TypeError -> 500.
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'expected { path, content }' });
  const path = safeDraftPath(payload.path);
  if (!path) return res.status(400).json({ error: `path must be a .md file under ${DRAFTS_PREFIX}` });
  if (typeof payload.content !== 'string') return res.status(400).json({ error: 'expected { path, content }' });
  // Content-Length can be absent or understated; enforce the cap against the
  // real UTF-8 byte length of the payload we are about to commit.
  if (Buffer.byteLength(payload.content, 'utf8') > MAX_BODY) return res.status(413).json({ error: 'payload too large' });
  const expectedSha = typeof payload.sha === 'string' && payload.sha && payload.sha !== 'dev-local' ? payload.sha : undefined;

  const gh = await commitDraft(path, payload.content, who.email, expectedSha);
  if (!gh.ok) return res.status(gh.status || 500).json({ error: gh.error });
  return res.status(200).json({ ok: true, saved: true, path, git: { committed: true, commit: gh.sha } });
}
