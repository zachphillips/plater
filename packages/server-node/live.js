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
// One fs.watch per hub (recursive; Node ≥ 20 supports it on Linux, macOS and
// Windows). Bursts are coalesced per path for DEBOUNCE_MS, because editors and
// agents often write a file as truncate-then-write, which fires twice.
// Dot-paths (.git, .env, .plater-review.json) and node_modules never emit:
// they are not part of the page and .git churns on every commit.
//
// Only plater dev and plater serve mount this. A static or serverless host has
// no long-lived process to watch from; the editor notices the missing stream
// and polls /api/content instead.
import fs from 'node:fs';
import path from 'node:path';

export const DEBOUNCE_MS = 120;
export const HEARTBEAT_MS = 25_000;

export function classify(rel, contentRel) {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return null;
  const ext = path.extname(rel).toLowerCase();
  const contentDir = path.dirname(contentRel);
  const underContent = contentDir === '.' || rel === contentRel || rel.startsWith(contentDir + path.sep) || rel.startsWith(contentDir + '/');
  if (ext === '.json' && underContent) return 'content';
  if (ext === '.css') return 'css';
  if (['.html', '.htm', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff2'].includes(ext)) return 'reload';
  return null;
}

/**
 * createLiveHub — watch a site's web root (and its content file, if it lives
 * outside the web root) and fan changes out to every connected /api/live client.
 * @returns {{ handle(req, res): void, close(): void, clients: () => number, emit(type, data): void }}
 */
export function createLiveHub({ webRoot, contentPath, debounceMs = DEBOUNCE_MS, heartbeatMs = HEARTBEAT_MS }) {
  const clients = new Set();
  const pending = new Map();
  const watchers = [];
  const contentRel = path.relative(webRoot, contentPath);

  function emit(type, data) {
    const frame = `event: ${type}\ndata: ${String(data).replace(/\n/g, ' ')}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function changed(rel) {
    if (!rel) return;
    const type = classify(rel, contentRel);
    if (!type) return;
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => { pending.delete(rel); emit(type, rel.split(path.sep).join('/')); }, debounceMs));
  }

  function watch(dir, prefix) {
    try {
      const w = fs.watch(dir, { recursive: true }, (_evt, name) => changed(name ? path.join(prefix, String(name)) : null));
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) {
      // Recursive watch is unsupported on this platform/filesystem: watch the
      // content directory alone, flat, so data edits still stream.
      try {
        const w = fs.watch(path.dirname(contentPath), (_evt, name) => changed(name ? path.join(path.dirname(contentRel), String(name)) : null));
        w.on('error', () => {});
        watchers.push(w);
      } catch {}
    }
  }

  watch(webRoot, '');
  // A content file outside the web root (GITHUB_EDIT_PATH pointing elsewhere).
  if (contentRel.startsWith('..')) {
    try {
      const w = fs.watch(path.dirname(contentPath), (_evt, name) => { if (name) emit('content', String(name)); });
      w.on('error', () => {});
      watchers.push(w);
    } catch {}
  }

  const beat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, heartbeatMs);
  beat.unref?.();

  return {
    handle(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1500\n: plater live\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    emit,
    clients: () => clients.size,
    close() {
      clearInterval(beat);
      for (const t of pending.values()) clearTimeout(t);
      for (const w of watchers) { try { w.close(); } catch {} }
      for (const res of clients) { try { res.end(); } catch {} }
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
  window.__platerLive = 'inject';
  const core = () => window.__platerCoreLive;
  const dirty = () => { try { return Boolean(core()?.dirty()); } catch { return false; } };
  let held = false;
  const hold = () => {
    if (held) return; held = true;
    const n = document.createElement('div');
    n.textContent = 'This page changed on disk. Save your edits, then reload to see it.';
    n.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#1a1a1a;color:#fff;font:13px/1.3 system-ui,sans-serif;padding:8px 14px;border-radius:6px';
    document.body.appendChild(n);
  };
  const reload = () => (dirty() ? hold() : location.reload());
  const es = new EventSource('/api/live');
  es.addEventListener('content', () => (core() ? core().pull() : reload()));
  es.addEventListener('reload', reload);
  es.addEventListener('css', (ev) => {
    const name = String(ev.data || '').split('/').pop();
    let hit = false;
    document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
      const u = new URL(l.href, location.href);
      if (name && u.pathname.split('/').pop() !== name) return;
      u.searchParams.set('plater-live', Date.now().toString(36));
      l.href = u.toString(); hit = true;
    });
    if (!hit) reload();
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
