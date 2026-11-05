// GET /api/live — a Server-Sent Events stream that tells open pages what just
// changed on disk, so a tab follows an agent's turn or another editor's save
// without anyone pressing reload.
//
//   event: content   data: <path relative to the web root>
//                    a .json under the content directory changed (site.json,
//                    a ?file= alternate, a versions/<track>/ draft overlay)
//   event: css       data: <path>   a stylesheet changed — pages swap its href
//   event: reload    data: <path>   HTML, a script, an image: pages reload
//
// One non-recursive fs.watch per directory, not one recursive watch: on Linux a
// recursive watch holds an inotify watch per FILE, so a file replaced by an
// atomic save (write temp + rename) or by git checkout goes silent forever, and
// .git / node_modules cost thousands of watches. A directory watch survives its
// files being replaced; new or recreated directories are re-armed as they
// appear. Dot-directories and node_modules are never entered. Bursts are
// coalesced per path for DEBOUNCE_MS, because editors and agents often write a
// file as truncate-then-write, which fires twice.
//
// Only plater dev and plater serve mount this. A static or serverless host has
// no long-lived process to watch from, so it has no live reload; the editor does
// not poll instead (see editor.js).
import fs from 'node:fs';
import path from 'node:path';

export const DEBOUNCE_MS = 120;
export const HEARTBEAT_MS = 25_000;
export const MAX_DIRS = 2000;
export const MAX_CLIENTS = 64;
// The asset types a page loads: stylesheets, scripts, images and fonts. One
// list, so what plater dev serves in single-file mode, what that mode streams
// and what reloads a page can never drift apart.
export const ASSET_EXT = /\.(css|m?js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i;
// Names that are plainly files: no need to stat them to see if a folder appeared.
const FILE_EXT = /\.(html?|css|m?js|json|md|txt|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|map|swp|tmp)$|~$/i;
// How many entries a folder that arrived whole is searched for changes.
const ANNOUNCE_MAX = 500;
const SKIP_DIR = (name) => name.startsWith('.') || name === 'node_modules';

export function classify(rel, contentRel) {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return null;
  const ext = path.extname(rel).toLowerCase();
  const contentDir = path.dirname(contentRel);
  const top = (r) => !/[\\/]/.test(r);
  // Content lives in the content file's folder: the file, ?file= alternates
  // beside it, and versions/<track>/ draft overlays. When that folder is the
  // web root itself, only top-level .json and versions/ count; any other .json
  // deeper in the site is an asset and reloads like one.
  const underContent = rel === contentRel || (contentDir === '.'
    ? top(rel) || /^versions[\\/]/.test(rel)
    : rel.startsWith(contentDir + path.sep) || rel.startsWith(contentDir + '/'));
  if (ext === '.json' && underContent) return 'content';
  if (ext === '.css') return 'css';
  if (ext === '.html' || ext === '.htm' || ext === '.json' || ASSET_EXT.test(rel)) return 'reload';
  return null;
}

/**
 * createLiveHub — watch a site's web root (and its content file, if it lives
 * outside the web root) and fan changes out to every connected /api/live client.
 * contentOnly: emit only `content` events and no file names (plater serve, where
 *   the stream is public and draft names and uploads are nobody's business).
 * entry: single-file mode (`platercms dev invoice.html`). Watch only the file's
 *   own folder, not its subfolders, and stream only the page itself and the
 *   assets beside it (ASSET_EXT), so sibling pages never reload it.
 * @returns {{ handle(req, res): void, close(): void, clients: () => number, watched: () => number, emit(type, data): void }}
 */
export function createLiveHub({ webRoot, contentPath, debounceMs = DEBOUNCE_MS, heartbeatMs = HEARTBEAT_MS, contentOnly = false, maxClients = MAX_CLIENTS, entry = null, log = console }) {
  const clients = new Set();
  const pending = new Map();
  const dirs = new Map();          // absolute dir -> { w, ino, birth }
  const extra = [];
  const contentRel = path.relative(webRoot, contentPath);
  let warned = false, closed = false;
  const warn = (msg, e) => { if (!warned) { warned = true; log.warn?.(`[plater live] ${msg}${e ? `: ${e.code || e.message}` : ''}`); } };

  function emit(type, data) {
    if (contentOnly && type !== 'content') return;
    const frame = `event: ${type}\ndata: ${contentOnly ? '' : String(data).replace(/\n/g, ' ')}\n\n`;
    send(frame);
  }

  // A client whose socket died between its close event and this write must not
  // throw out of a watcher callback or the heartbeat; drop it instead.
  function send(frame) {
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); try { res.destroy?.(); } catch {} }
    }
  }

  function changed(rel, type = classify(rel, contentRel)) {
    if (!rel || !type) return;
    if (entry && rel !== entry && !ASSET_EXT.test(rel)) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => { pending.delete(rel); emit(type, rel.split(path.sep).join('/')); }, debounceMs));
  }

  function unwatch(dir) {
    for (const [d, entry] of dirs) {
      if (d === dir || d.startsWith(dir + path.sep)) { try { entry.w.close(); } catch {} dirs.delete(d); }
    }
  }

  // Returns true when it armed a folder that was not being watched as it is now
  // (new, or replaced by git checkout / an atomic folder swap).
  function watchTree(dir) {
    if (closed) return false;
    let st;
    try { st = fs.statSync(dir); } catch { unwatch(dir); return false; }
    if (!st.isDirectory()) return false;
    const have = dirs.get(dir);
    // Inodes are reused quickly on some filesystems (a delete then recreate can
    // get the same number back), so the birth time has to match too.
    if (have && have.ino === st.ino && have.birth === st.birthtimeMs) return false;
    if (have) unwatch(dir);                 // the folder was replaced: re-arm it
    if (entry && dir !== webRoot) return false;   // single-file mode: the page's own folder only
    if (dirs.size >= MAX_DIRS) { warn(`more than ${MAX_DIRS} folders under ${webRoot}; live reload is watching only the first ${MAX_DIRS}`); return false; }
    try {
      const w = fs.watch(dir, (_evt, name) => {
        // Node may give no file name on some platforms and filesystems. Then we
        // cannot tell what changed, so re-arm the folder's subfolders and
        // announce the whole folder, the same as one that arrived whole.
        if (!name) {
          let subs = [];
          try { subs = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
          for (const d of subs) if (d.isDirectory() && !SKIP_DIR(d.name)) watchTree(path.join(dir, d.name));
          return announce(dir);
        }
        const abs = path.join(dir, String(name));
        changed(path.relative(webRoot, abs));
        // A new or replaced subfolder arrives already full (git checkout, a
        // folder swapped in whole): its files fire no events of their own, so
        // announce what it brought.
        if (!SKIP_DIR(String(name)) && !FILE_EXT.test(String(name)) && watchTree(abs)) announce(abs);
      });
      w.on('error', (e) => { dirs.delete(dir); try { w.close(); } catch {} if (e.code !== 'EPERM') warn(`stopped watching ${dir}`, e); });
      dirs.set(dir, { w, ino: st.ino, birth: st.birthtimeMs });
    } catch (e) {
      warn(`cannot watch ${dir}`, e);
      return false;
    }
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const d of names) if (d.isDirectory() && !SKIP_DIR(d.name)) watchTree(path.join(dir, d.name));
    return true;
  }

  // A folder that appeared whole (or changed with no file name): its files fired
  // no events of their own, so walk it, nested folders included, and announce
  // what it holds. Content is pulled; one page-level change means one reload,
  // which makes any stylesheet swap moot; otherwise every stylesheet is swapped.
  function announce(dir) {
    const found = { content: null, reload: null, css: [] };
    const stack = [dir];
    let seen = 0;
    while (stack.length && seen < ANNOUNCE_MAX) {
      const d = stack.pop();
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch {}
      for (const n of names) {
        if (++seen > ANNOUNCE_MAX) break;
        if (SKIP_DIR(n.name)) continue;
        const abs = path.join(d, n.name);
        if (n.isDirectory()) { stack.push(abs); continue; }
        const r = path.relative(webRoot, abs);
        const type = classify(r, contentRel);
        if (type === 'content') found.content ??= r;
        else if (type === 'reload' && (!entry || r === entry || ASSET_EXT.test(r))) found.reload ??= r;
        else if (type === 'css') found.css.push(r);
      }
    }
    if (found.content) changed(found.content, 'content');
    if (found.reload) changed(found.reload, 'reload');
    else for (const r of found.css) changed(r, 'css');
  }

  watchTree(webRoot);
  // The web root itself can be replaced (a checkout that swaps the folder);
  // nothing inside it can see that, so watch its parent for its name.
  try {
    const name = path.basename(webRoot);
    const w = fs.watch(path.dirname(webRoot), (_evt, n) => {
      if (n && String(n) === name && watchTree(webRoot)) { if (entry) changed(entry, 'reload'); else announce(webRoot); }
    });
    w.on('error', () => {});
    extra.push(w);
  } catch {}
  // A content file outside the web root (GITHUB_EDIT_PATH pointing elsewhere):
  // watch just that file's folder, through the same debounce, content only.
  if (contentRel.startsWith('..')) {
    const base = path.basename(contentPath);
    try {
      const w = fs.watch(path.dirname(contentPath), (_evt, name) => { if (name && String(name) === base) changed(contentRel, 'content'); });
      w.on('error', (e) => warn(`stopped watching ${contentPath}`, e));
      extra.push(w);
    } catch (e) { warn(`cannot watch ${contentPath}`, e); }
  }

  const beat = setInterval(() => send(': ping\n\n'), heartbeatMs);
  beat.unref?.();

  return {
    handle(req, res) {
      if (clients.size >= maxClients) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' });
        return res.end('too many live connections');
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1500\n: plater live\n\n');
      clients.add(res);
      // The response closing is what ends a stream; the request closing is kept
      // as a second signal. Deleting twice is harmless.
      const drop = () => clients.delete(res);
      res.on?.('close', drop);
      req.on('close', drop);
    },
    emit,
    clients: () => clients.size,
    watched: () => dirs.size,
    close() {
      closed = true;
      clearInterval(beat);
      for (const t of pending.values()) clearTimeout(t);
      for (const { w } of dirs.values()) { try { w.close(); } catch {} }
      for (const w of extra) { try { w.close(); } catch {} }
      dirs.clear();
      for (const res of clients) { try { res.end(); res.socket?.destroy(); } catch {} }
      clients.clear();
    },
  };
}

// The standalone page client plater dev injects into every HTML page it
// serves. It gives live reload to pages with no Plater editor at all (decks,
// mail, a one-file invoice): CSS swaps in place, anything else reloads. When
// the Plater editor is on the page it registers window.__platerCoreLive and
// this client hands content events to it instead of reloading, so the page
// re-renders with the caret and any unsaved edits intact.
export const LIVE_CLIENT = `(() => {
  if (window.__platerLive || typeof EventSource !== 'function') return;
  // Headless capture (Playwright, Puppeteer, the ?shot / ?print contracts) waits
  // for the network to go idle; an open stream would keep it waiting forever.
  const q = new URLSearchParams(location.search);
  if (navigator.webdriver || q.has('shot') || q.has('print')) return;
  window.__platerLive = 'inject';
  // The Plater editor, when it is on the page, registers this bridge as soon as
  // it starts: off is initPlater({ live: false }), mine(path) is a change this
  // tab made itself (an image it just uploaded).
  const core = () => window.__platerCoreLive;
  const off = () => Boolean(core()?.off);
  if (off()) return;
  const dirty = () => { try { return Boolean(core()?.dirty()); } catch { return false; } };
  const mine = (p) => { try { return Boolean(core()?.mine?.(p)); } catch { return false; } };
  let held = false;
  const hold = () => {
    if (held) return; held = true;
    const n = document.createElement('div');
    n.textContent = 'This page changed on disk. Save your edits, then reload to see it.';
    n.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#1a1a1a;color:#fff;font:13px/1.3 system-ui,sans-serif;padding:8px 14px;border-radius:6px';
    document.body.appendChild(n);
  };
  const reload = (ev) => (mine(ev?.data) ? undefined : dirty() ? hold() : location.reload());
  const es = new EventSource('/api/live');
  const on = (type, fn) => es.addEventListener(type, (ev) => (off() ? es.close() : fn(ev)));
  on('content', (ev) => (core() ? core().pull() : reload(ev)));
  on('reload', reload);
  on('css', (ev) => {
    // Match the changed path (relative to the web root, served at /) against
    // same-origin stylesheets; fall back to the file name only if none match.
    const rel = String(ev.data || '').replace(/^\\/+/, '');
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((l) => ({ l, u: new URL(l.href, location.href) })).filter(({ u }) => u.origin === location.origin);
    let hits = links.filter(({ u }) => decodeURIComponent(u.pathname).replace(/^\\/+/, '') === rel);
    if (!hits.length && rel) { const name = rel.split('/').pop(); hits = links.filter(({ u }) => u.pathname.split('/').pop() === name); }
    hits.forEach(({ l, u }) => { u.searchParams.set('plater-live', Date.now().toString(36)); l.href = u.toString(); });
    if (!hits.length) reload();
  });
})();
`;

// Add the client to an HTML document, just before </body> (or at the end).
export function injectLiveClient(html) {
  const tag = '<script src="/__plater/live.js" defer></script>';
  if (html.includes(tag)) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}
