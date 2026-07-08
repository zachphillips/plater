// @plater/core — framework-free in-place CMS editor.
//
// Renders content/site.json into the page and provides a Google-SSO-or-edit-token
// gated editor that commits edits back to git via /api/save. Extracted and
// modularized from the Sherwood reference implementation (which was reused
// verbatim across The Great Rebellion and Sherwood). Behavior is unchanged;
// site-specific bits (brand, token key, card templates, api base) are options.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, val) => {
  const keys = path.split('.');
  const last = keys.pop();
  const tgt = keys.reduce((o, k) => (o[k] ??= {}), obj);
  tgt[last] = val;
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------------- sitemap / review rail styles ---------------- */
// Injected on demand (like @plater/capture) so consumer sites need no CSS changes.
// Palette matches the Plater edit-bar aesthetic: #1c1c1c bar, #333 hairlines,
// #c9a96e accent, #8a8277 muted.
const SMAP = 'plater-smap';
function injectSitemapStyles() {
  if (document.getElementById(`${SMAP}-style`)) return;
  const css = `
  .${SMAP}{position:fixed;left:0;z-index:49;width:264px;max-width:80vw;bottom:0;overflow-y:auto;
    background:#161616;border-right:1px solid #2a2a2a;color:#e8e3d9;
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    transform:translateX(-100%);transition:transform .18s ease;box-shadow:8px 0 30px -18px rgba(0,0,0,.8)}
  .${SMAP}.open{transform:none}
  body.${SMAP}-open{transition:padding-left .18s ease}
  @media (min-width: 900px){ body.${SMAP}-open{padding-left:264px} }
  .${SMAP} header{position:sticky;top:0;display:flex;align-items:baseline;gap:8px;padding:11px 14px;
    background:#191919;border-bottom:1px solid #2a2a2a}
  .${SMAP} header b{font:700 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#c9a96e}
  .${SMAP}-count{margin-left:auto;font:600 11px/1 ui-monospace,Menlo,monospace;color:#8a8277}
  .${SMAP}-count.done{color:#7fae7f}
  .${SMAP}-group{padding:8px 0 2px}
  .${SMAP}-group-label{padding:4px 14px;font:600 10px/1.4 ui-monospace,Menlo,monospace;
    letter-spacing:.1em;text-transform:uppercase;color:#6d665c}
  .${SMAP}-item{display:flex;align-items:center;gap:8px;padding:6px 14px 6px 18px;text-decoration:none;
    color:#b8b0a4;border-left:2px solid transparent}
  .${SMAP}-item:hover{background:#1e1c18;color:#e8e3d9}
  .${SMAP}-item.current{border-left-color:#c9a96e;background:#1f1b13;color:#e8e3d9}
  .${SMAP}-item .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .${SMAP}-item .p{display:block;font:400 10px/1.3 ui-monospace,Menlo,monospace;color:#6d665c;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .${SMAP}-check{appearance:none;-webkit-appearance:none;flex:none;width:15px;height:15px;margin:0;
    border:1.5px solid #6d665c;border-radius:4px;background:transparent;cursor:pointer;position:relative}
  .${SMAP}-check:hover{border-color:#c9a96e}
  .${SMAP}-check:checked{background:#c9a96e;border-color:#c9a96e}
  .${SMAP}-check:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;
    border:solid #151208;border-width:0 2px 2px 0;transform:rotate(45deg)}
  .${SMAP}-done{flex:none;width:15px;text-align:center;color:#7fae7f;font-size:12px;cursor:pointer;opacity:.75}
  .${SMAP}-done:hover{opacity:1}
  .${SMAP}-stale{flex:none;font:600 9px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.06em;color:#d0a24a;
    text-transform:uppercase}
  .${SMAP}-foot{padding:10px 14px 14px;font:400 11px/1.5 inherit;color:#6d665c;border-top:1px solid #232323;margin-top:8px}
  .${SMAP}-toggle{background:#1b1813 !important;border:1px solid #3a352b !important;color:#c9a96e !important}
  .${SMAP}-toggle[aria-pressed="true"]{background:#c9a96e !important;color:#151208 !important;border-color:#c9a96e !important}
  `;
  const s = document.createElement('style'); s.id = `${SMAP}-style`; s.textContent = css;
  document.head.appendChild(s);
}

// '/index.html' and '/' are the same page; directories keep their trailing slash.
const normalizePagePath = (p) => {
  let out = String(p || '/');
  if (out.endsWith('/index.html')) out = out.slice(0, -'index.html'.length);
  return out === '' ? '/' : out;
};

/**
 * initPlater — boot the in-place editor on the current page.
 *
 * @param {object} options
 * @param {string} [options.brand='Site']         Label used in the toolbar + token prompt.
 * @param {string} [options.apiBase='/api']        Base path for config/content/save endpoints.
 * @param {string} [options.tokenKey]              localStorage key for the edit token.
 * @param {object} [options.cardTemplates={}]      Map of content-path -> template selector,
 *                                                 used as a fallback when a [data-cards] element
 *                                                 lacks a nested <template> / data-card-template.
 * @param {function} [options.onSaved]             Called with (content, result) after a save.
 * @returns {{getContent:Function, setEditable:Function, save:Function, refresh:Function}}
 */
export function initZMS(options = {}) {
  const {
    brand = 'Site',
    apiBase = '/api',
    tokenKey = `zms.${slug(brand)}.editToken`,
    cardTemplates = {},
    onSaved = null,
  } = options;

  let CONTENT = {};
  let SAVED = '{}';
  let CONFIG = { editable: false, googleClientId: '', tokenAuth: false, devNoauth: false, adminEmail: '', agentRouting: false };
  let ID_TOKEN = null;      // bearer sent to /api/save: a Google ID token OR the edit token
  let EDITING = false;

  function setLoggedIn(on) {
    document.body.classList.toggle('plater-logged-in', Boolean(on));
  }

  /* ---------------- render ---------------- */

  function render() {
    $$('[data-bind]').forEach((el) => {
      const path = el.dataset.bind;
      const val = getPath(CONTENT, path);
      if (val == null) return;
      if (typeof val === 'object' && ('label' in val || 'href' in val)) {
        if (val.label != null) el.textContent = val.label;
        if (val.href != null && 'href' in el) el.setAttribute('href', val.href);
        if (val.label != null) el.dataset.path = path + '.label';
      } else {
        el.textContent = String(val);
        el.dataset.path = path;
      }
    });

    $$('[data-bind-attr]').forEach((el) => {
      const [path, attr] = el.dataset.bindAttr.split(':');
      const val = getPath(CONTENT, path);
      if (val != null) el.setAttribute(attr, String(val));
    });

    $$('[data-list]').forEach((el) => {
      const path = el.dataset.list;
      const tag = el.dataset.listTag || 'p';
      const arr = getPath(CONTENT, path) || [];
      el.innerHTML = '';
      arr.forEach((item, i) => {
        const node = document.createElement(tag);
        node.textContent = item;
        node.dataset.path = `${path}.${i}`;
        el.appendChild(node);
      });
    });

    $$('[data-cards]').forEach((el) => {
      const path = el.dataset.cards;
      const arr = getPath(CONTENT, path) || [];
      const tmpl = el.querySelector('template')
        || (el.dataset.cardTemplate && document.querySelector(`#${el.dataset.cardTemplate}`))
        || (cardTemplates[path] && document.querySelector(cardTemplates[path]));
      if (!tmpl) return;
      [...el.children].forEach((c) => { if (c.tagName !== 'TEMPLATE') c.remove(); });
      arr.forEach((item, i) => {
        const frag = tmpl.content.cloneNode(true);
        frag.querySelectorAll('[data-field]').forEach((f) => {
          const key = f.dataset.field;
          if (item[key] == null) return;
          f.textContent = String(item[key]);
          f.dataset.path = `${path}.${i}.${key}`;
        });
        frag.querySelectorAll('[data-field-link]').forEach((f) => {
          const href = item[f.dataset.fieldLink];
          if (href) { f.setAttribute('href', href); f.hidden = false; }
          else { f.hidden = true; }
        });
        frag.querySelectorAll('[data-field-style]').forEach((f) => {
          const [key, prop] = f.dataset.fieldStyle.split(':');
          if (item[key] != null) f.style[prop] = String(item[key]);
        });
        el.appendChild(frag);
      });
    });

    $$('[data-links]').forEach((el) => {
      const arr = getPath(CONTENT, el.dataset.links) || [];
      el.innerHTML = '';
      arr.forEach((l) => {
        const a = document.createElement('a');
        a.textContent = l.label; a.href = l.href;
        el.appendChild(a);
      });
    });

    const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
    document.title = getPath(CONTENT, 'meta.title') || document.title;
  }

  /* ---------------- editing ---------------- */

  function collectEdits() {
    $$('[data-path]').forEach((el) => {
      setPath(CONTENT, el.dataset.path, el.textContent.trim());
    });
  }

  function setEditable(on) {
    EDITING = on;
    document.body.classList.toggle('cms-editing', on);
    $$('[data-path]').forEach((el) => {
      if (on) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
    if ($('#cms-edit')) $('#cms-edit').hidden = on;
    if ($('#cms-save')) $('#cms-save').hidden = !on;
    if ($('#cms-cancel')) $('#cms-cancel').hidden = !on;
    if ($('#cms-status')) $('#cms-status').textContent = on ? 'editing — your changes are local until you Save' : 'signed in';
  }

  async function save() {
    collectEdits();
    if ($('#cms-status')) $('#cms-status').textContent = 'saving…';
    const headers = { 'content-type': 'application/json' };
    if (ID_TOKEN) headers.authorization = 'Bearer ' + ID_TOKEN;
    try {
      const r = await fetch(`${apiBase}/save`, { method: 'POST', headers, body: JSON.stringify({ content: CONTENT }) });
      const out = await r.json();
      if (!r.ok || out.error) {
        if (r.status === 401 && CONFIG.tokenAuth && !CONFIG.googleClientId) {
          ID_TOKEN = null;
          try { localStorage.removeItem(tokenKey); } catch {}
        }
        if ($('#cms-status')) $('#cms-status').textContent = 'save failed: ' + (out.error || r.status);
        return;
      }
      SAVED = JSON.stringify(CONTENT);
      const c = out.git && out.git.commit;
      if ($('#cms-status')) $('#cms-status').textContent = c ? `saved & committed ${c}` : 'saved';
      setEditable(false);
      // a save can change what a page shows → review hashes may have flipped
      refreshSitemap().catch(() => {});
      if (typeof onSaved === 'function') onSaved(CONTENT, out);
    } catch (e) {
      if ($('#cms-status')) $('#cms-status').textContent = 'save error: ' + e.message;
    }
  }

  function cancel() {
    CONTENT = JSON.parse(SAVED);
    setEditable(false);
    render();
  }

  /* ---------------- edit-token fallback ---------------- */

  function useEditToken(tok) {
    ID_TOKEN = tok;
    try { localStorage.setItem(tokenKey, tok); } catch {}
    setLoggedIn(true);
    if ($('#cms-signin')) $('#cms-signin').hidden = true;
    if ($('#cms-edit')) $('#cms-edit').hidden = false;
    if ($('#cms-status')) $('#cms-status').textContent = 'edit token set — Edit page to begin';
  }

  function promptForToken() {
    let tok = ID_TOKEN;
    try { tok = tok || localStorage.getItem(tokenKey); } catch {}
    if (!tok) {
      tok = window.prompt(`Enter the ${brand} edit token`);
      if (tok == null) return;
      tok = tok.trim();
      if (!tok) { if ($('#cms-status')) $('#cms-status').textContent = 'edit token required'; return; }
    }
    useEditToken(tok);
  }

  /* ---------------- google sign-in ---------------- */

  function loadGIS() {
    return new Promise((res, rej) => {
      if (window.google?.accounts?.id) return res();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function initSignIn() {
    if (!CONFIG.googleClientId) return;
    await loadGIS().catch(() => null);
    if (!window.google?.accounts?.id) return;
    google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      callback: (resp) => {
        ID_TOKEN = resp.credential;
        setLoggedIn(true);
        if ($('#cms-signin')) $('#cms-signin').hidden = true;
        if ($('#cms-edit')) $('#cms-edit').hidden = false;
        if ($('#cms-status')) $('#cms-status').textContent = 'signed in';
      },
    });
    google.accounts.id.renderButton($('#cms-signin'), { theme: 'filled_black', size: 'small', text: 'signin' });
  }

  /* ---------------- sitemap + review rail ---------------- */
  // Edit-mode left sidebar: outline of the site's pages (from GET api/review),
  // click to navigate (preserving ?edit), with persistent per-page review
  // state. Checkboxes appear only for pushed-but-unreviewed pages; reviewed
  // pages show a subtle done tick instead.

  let smapEl = null;
  let smapToggle = null;
  let smapStatus = null; // last fetched review status payload
  let smapAvailable = false;

  const currentPagePath = () => normalizePagePath(location.pathname);

  async function fetchReviewStatus() {
    try {
      const r = await fetch(`${apiBase}/review`, { cache: 'no-store' });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data || !Array.isArray(data.pages)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function markReviewed(pagePath, reviewed) {
    const headers = { 'content-type': 'application/json' };
    if (ID_TOKEN) headers.authorization = 'Bearer ' + ID_TOKEN;
    const r = await fetch(`${apiBase}/review`, {
      method: 'POST', headers,
      body: JSON.stringify({ path: pagePath, reviewed }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.error) throw new Error(out.error || `review save failed (${r.status})`);
    smapStatus = out;
    renderSitemap();
    if ($('#cms-status')) {
      $('#cms-status').textContent = reviewed
        ? (out.fully_reviewed ? 'page reviewed — site fully reviewed ✓' : `page reviewed (${out.counts.reviewed}/${out.counts.total})`)
        : 'page marked unreviewed';
    }
  }

  function groupPages(pages) {
    const groups = new Map();
    for (const p of pages) {
      const segs = normalizePagePath(p.path).split('/').filter(Boolean);
      const key = segs.length > 1 ? segs[0] : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    // root group first, then alphabetical
    return [...groups.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])));
  }

  function renderSitemap() {
    if (!smapEl || !smapStatus) return;
    const here = currentPagePath();
    const { pages, counts } = smapStatus;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const allDone = counts.total > 0 && counts.reviewed === counts.total;

    let html = `<header><b>Pages</b><span class="${SMAP}-count${allDone ? ' done' : ''}">` +
      `${counts.reviewed}/${counts.total} reviewed</span></header>`;

    for (const [group, items] of groupPages(pages)) {
      html += `<div class="${SMAP}-group">`;
      if (group) html += `<div class="${SMAP}-group-label">${esc(group)}/</div>`;
      for (const p of items) {
        const norm = normalizePagePath(p.path);
        const isHere = norm === here;
        const label = p.title || norm;
        html += `<a class="${SMAP}-item${isHere ? ' current' : ''}" href="${esc(norm)}?edit" data-page="${esc(norm)}">`;
        if (p.reviewed) {
          html += `<span class="${SMAP}-done" data-unreview="${esc(norm)}" title="Reviewed ${p.reviewed_at ? new Date(p.reviewed_at).toLocaleString() : ''} — click to mark unreviewed">✓</span>`;
        } else {
          html += `<input type="checkbox" class="${SMAP}-check" data-review="${esc(norm)}" title="Mark reviewed">`;
        }
        html += `<span class="t">${esc(label)}<span class="p">${esc(norm)}</span></span>`;
        if (p.stale) html += `<span class="${SMAP}-stale" title="Changed since last review">edited</span>`;
        html += `</a>`;
      }
      html += `</div>`;
    }
    html += `<div class="${SMAP}-foot">Click a page to open it in edit mode. ` +
      `Tick the box once you’ve read it — edits after review flip it back automatically.` +
      `${counts.total ? ' Press <b>r</b> to mark this page reviewed.' : ''}</div>`;
    smapEl.innerHTML = html;

    smapEl.querySelectorAll(`[data-review]`).forEach((cb) => {
      cb.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        cb.disabled = true;
        markReviewed(cb.dataset.review, true).catch((err) => {
          cb.disabled = false; cb.checked = false;
          if ($('#cms-status')) $('#cms-status').textContent = err.message;
        });
      });
    });
    smapEl.querySelectorAll(`[data-unreview]`).forEach((tick) => {
      tick.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        markReviewed(tick.dataset.unreview, false).catch((err) => {
          if ($('#cms-status')) $('#cms-status').textContent = err.message;
        });
      });
    });
  }

  function positionSitemap() {
    if (!smapEl) return;
    const bar = $('#cms-bar');
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!bar || bar.hidden) { smapEl.style.top = '0px'; smapEl.style.bottom = '0px'; return; }
    const r = bar.getBoundingClientRect();
    // The edit bar can be pinned to the top (full-width) or floated at the
    // bottom (a centered pill, as on The Great Rebellion). A bottom bar sits in
    // the lower half of the viewport — anchoring the rail's TOP to bar.bottom
    // there would crush it into a sliver, so fill from the top down to just
    // above the bar instead.
    if (r.top > vh / 2) {
      smapEl.style.top = '0px';
      smapEl.style.bottom = Math.max(0, Math.round(vh - r.top + 8)) + 'px';
    } else {
      smapEl.style.top = Math.max(0, Math.round(r.bottom)) + 'px';
      smapEl.style.bottom = '0px';
    }
  }

  function setSitemapOpen(open) {
    if (!smapEl) return;
    positionSitemap();
    smapEl.classList.toggle('open', open);
    document.body.classList.toggle(`${SMAP}-open`, open);
    if (smapToggle) smapToggle.setAttribute('aria-pressed', String(open));
    try { sessionStorage.setItem(`${SMAP}.open`, open ? '1' : '0'); } catch {}
  }
  const sitemapOpen = () => Boolean(smapEl && smapEl.classList.contains('open'));

  async function initSitemap() {
    if (smapEl) return; // once
    smapStatus = await fetchReviewStatus();
    // Sitemap is a multi-page affordance; skip silently on single-page sites
    // or when the server doesn't expose the review endpoint.
    if (!smapStatus || smapStatus.pages.length < 2) return;
    smapAvailable = true;

    injectSitemapStyles();
    smapEl = document.createElement('nav');
    smapEl.className = SMAP;
    smapEl.setAttribute('aria-label', 'Site map');
    document.body.appendChild(smapEl);
    renderSitemap();

    const bar = $('#cms-bar');
    if (bar) {
      smapToggle = document.createElement('button');
      smapToggle.type = 'button';
      smapToggle.className = `${SMAP}-toggle`;
      smapToggle.textContent = '☰ Pages';
      smapToggle.title = 'Site map + review checklist';
      smapToggle.setAttribute('aria-pressed', 'false');
      smapToggle.addEventListener('click', () => setSitemapOpen(!sitemapOpen()));
      bar.insertBefore(smapToggle, bar.querySelector('#cms-status'));
    }

    window.addEventListener('resize', positionSitemap);

    // `r` marks the current page reviewed while the sitemap is open — but only
    // when the keystroke isn't going into text (inputs / contenteditable).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!sitemapOpen()) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
      const page = smapStatus && smapStatus.pages.find((p) => normalizePagePath(p.path) === currentPagePath());
      if (!page || page.reviewed) return;
      e.preventDefault();
      markReviewed(currentPagePath(), true).catch((err) => {
        if ($('#cms-status')) $('#cms-status').textContent = err.message;
      });
    });

    // restore open state across in-edit-mode navigation
    let restore = true;
    try { restore = sessionStorage.getItem(`${SMAP}.open`) !== '0'; } catch {}
    if (restore) setSitemapOpen(true);
  }

  async function refreshSitemap() {
    if (!smapAvailable) return;
    const fresh = await fetchReviewStatus();
    if (fresh) { smapStatus = fresh; renderSitemap(); }
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    try {
      const [cfg, content] = await Promise.all([
        fetch(`${apiBase}/config`).then((r) => r.json()).catch(() => CONFIG),
        fetch(`${apiBase}/content`).then((r) => r.json()),
      ]);
      CONFIG = { ...CONFIG, ...cfg };
      CONTENT = content;
    } catch (e) {
      console.error('[zms] content load failed', e);
      return;
    }
    SAVED = JSON.stringify(CONTENT);
    render();

    try { ID_TOKEN = ID_TOKEN || localStorage.getItem(tokenKey); } catch {}
    setLoggedIn(Boolean(ID_TOKEN));

    // edit mode is opt-in: ?edit  OR  Cmd/Ctrl+E  OR  the toolbar button
    const wantEdit = new URLSearchParams(location.search).has('edit');
    const enableEditUI = () => {
      const bar = $('#cms-bar'); if (bar) bar.hidden = false;
      initSitemap().then(positionSitemap).catch(() => {});
      if (CONFIG.googleClientId) { if ($('#cms-signin')) $('#cms-signin').hidden = false; initSignIn(); }
      else if (CONFIG.tokenAuth) { promptForToken(); }
      else if (CONFIG.devNoauth) { setLoggedIn(true); if ($('#cms-edit')) $('#cms-edit').hidden = false; if ($('#cms-status')) $('#cms-status').textContent = 'dev mode — no auth (localhost)'; }
      else { if ($('#cms-status')) $('#cms-status').textContent = 'editing not configured (set GOOGLE_CLIENT_ID or CMS_EDIT_TOKEN)'; }
    };
    if (wantEdit) enableEditUI();
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); enableEditUI(); }
    });

    // The labelled admin entry point into the live in-place editor.
    const impeccable = $('#cms-impeccable');
    if (impeccable) impeccable.addEventListener('click', () => {
      enableEditUI();
      if (!EDITING && (ID_TOKEN || CONFIG.devNoauth)) setEditable(true);
    });
    if ($('#cms-edit')) $('#cms-edit').addEventListener('click', () => setEditable(true));
    if ($('#cms-save')) $('#cms-save').addEventListener('click', save);
    if ($('#cms-cancel')) $('#cms-cancel').addEventListener('click', cancel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return {
    getContent: () => CONTENT,
    setEditable,
    save,
    refresh: render,
    // Exposed so @plater/capture can authenticate note-routing with the same
    // credential the editor uses (Google ID token or shared edit token).
    getToken: () => ID_TOKEN,
    getConfig: () => CONFIG,
  };
}

export const initPlater = initZMS;
export default initZMS;
