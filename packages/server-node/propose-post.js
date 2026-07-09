// /api/propose-post — the publishing-pipeline handoff into Plater.
//
// A draft arriving from the ibsky publishing pipeline (publish-queue.jsonl,
// source.file pointing at a markdown draft) can open HERE in a minimal edit
// surface for Zach's polish pass before he stages it. Deliberately small and
// real: load a draft file by path, edit it, save it back through Plater's
// existing git-commit save path (GitHub Contents API, same auth as /api/save).
// No social-posting UI, no scheduling, no publish button — THE RULING
// (2026-07-09): agents draft, Zach edits, Zach publishes. This surface only
// edits words.
//
//   GET  /api/propose-post?path=drafts/foo.md            → the edit view (HTML)
//   GET  /api/propose-post?path=drafts/foo.md&format=json → { path, content, sha }
//   POST /api/propose-post { path, content }             → commit via GitHub
//        (auth: Google ID token OR shared edit token — identical to /api/save)
//
// Config (env):
//   PLATER_DRAFTS_PREFIX  repo path prefix drafts must live under
//                         (default 'drafts/'; the pipeline convention is
//                         'publish-drafts/' in ibsky-fed repos)
//   + the same GITHUB_REPOSITORY / GITHUB_BRANCH / auth env as save.js.
import crypto from 'node:crypto';

const ADMIN_EMAIL = (process.env.CMS_ADMIN_EMAIL || 'zach@thekitchen.co').toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const EDIT_TOKEN = process.env.CMS_EDIT_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const DRAFTS_PREFIX = (process.env.PLATER_DRAFTS_PREFIX || 'drafts/').replace(/^\/+/, '');
const SITE_NAME = process.env.CMS_SITE_NAME || 'site';
const MAX_BODY = 2_000_000;

/* ---------------- auth (same contract as save.js / review.js) ------------ */

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function verifyGoogle(idToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
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
  if (!auth) return { ok: false, status: 401, reason: `sign in as ${ADMIN_EMAIL} to save` };
  if (EDIT_TOKEN && safeEqual(auth, EDIT_TOKEN)) return { ok: true, email: ADMIN_EMAIL };
  const verified = await verifyGoogle(auth);
  if (!verified.ok) return { ok: false, status: 401, reason: 'auth failed: ' + verified.reason };
  return { ok: true, email: verified.email };
}

/* ---------------- draft path safety --------------------------------------
   Only markdown drafts under the configured prefix are reachable — this is a
   handoff surface for pipeline drafts, not a general file editor. */
export function safeDraftPath(raw) {
  const p = String(raw || '').replace(/^\/+/, '');
  if (!p || p.includes('..') || p.includes('\\') || !p.endsWith('.md')) return null;
  if (!p.startsWith(DRAFTS_PREFIX)) return null;
  return p;
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
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(api, { headers: ghHeaders(token), cache: 'no-store' });
  if (r.status === 404) return { ok: false, status: 404, error: 'draft not found: ' + path };
  if (!r.ok) return { ok: false, status: 502, error: `github read ${r.status}` };
  const file = await r.json();
  return { ok: true, sha: file.sha, content: Buffer.from(file.content || '', 'base64').toString('utf8') };
}

async function commitDraft(path, content, who) {
  const token = process.env.GITHUB_TOKEN || process.env.CMS_GITHUB_TOKEN;
  if (!token || !GITHUB_REPOSITORY) return { ok: false, status: 501, error: 'missing GITHUB_TOKEN / GITHUB_REPOSITORY' };
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${path}`;
  let sha;
  const get = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: ghHeaders(token), cache: 'no-store' });
  if (get.ok) sha = (await get.json()).sha;
  else if (get.status !== 404) return { ok: false, status: 502, error: `github read ${get.status}` };
  const put = await fetch(api, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `draft(${SITE_NAME}): polish ${path} via propose-post by ${who}`,
      content: Buffer.from(String(content)).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
      committer: { name: 'Heard CMS', email: ADMIN_EMAIL },
      author: { name: 'Zach Phillips', email: ADMIN_EMAIL },
    }),
  });
  if (!put.ok) return { ok: false, status: 502, error: `github write ${put.status}: ${(await put.text()).slice(0, 300)}` };
  return { ok: true, sha: (await put.json()).commit?.sha };
}

/* ---------------- the minimal edit view ----------------------------------
   Plater edit-bar aesthetic (#1c1c1c bar, #c9a96e accent). One textarea, one
   save action; the words are the interface. Exported so the example
   dev-server can mount the same view against local files. */
export function editView(path) {
  const p = JSON.stringify(path);
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
function status(msg,cls){st.textContent=msg;st.className=cls||''}
async function load(){
  const r=await fetch('?path='+encodeURIComponent(PATH)+'&format=json',{cache:'no-store'});
  const j=await r.json();
  if(!r.ok){status(j.error||('load failed '+r.status),'err');return}
  t.value=j.content;t.disabled=false;btn.disabled=false;status('loaded — make it yours');
}
btn.onclick=async()=>{
  if(!token){token=window.prompt('Plater edit token');if(!token)return;try{localStorage.setItem(tokenKey,token)}catch{}}
  btn.disabled=true;status('saving…');
  const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({path:PATH,content:t.value})});
  const j=await r.json().catch(()=>({}));
  btn.disabled=false;
  if(!r.ok){if(r.status===401){try{localStorage.removeItem(tokenKey)}catch{};token=''}status(j.error||('save failed '+r.status),'err');return}
  status('saved — committed '+((j.git&&j.git.commit)||'').slice(0,7),'ok');
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
  const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  const path = safeDraftPath(payload.path);
  if (!path) return res.status(400).json({ error: `path must be a .md file under ${DRAFTS_PREFIX}` });
  if (typeof payload.content !== 'string') return res.status(400).json({ error: 'expected { path, content }' });

  const gh = await commitDraft(path, payload.content, who.email);
  if (!gh.ok) return res.status(gh.status || 500).json({ error: gh.error });
  return res.status(200).json({ ok: true, saved: true, path, git: { committed: true, commit: gh.sha } });
}
