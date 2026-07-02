// @zms/core — framework-free in-place CMS editor.
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

/**
 * initZMS — boot the in-place editor on the current page.
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
        if ($('#cms-signin')) $('#cms-signin').hidden = true;
        if ($('#cms-edit')) $('#cms-edit').hidden = false;
        if ($('#cms-status')) $('#cms-status').textContent = 'signed in';
      },
    });
    google.accounts.id.renderButton($('#cms-signin'), { theme: 'filled_black', size: 'small', text: 'signin' });
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

    // edit mode is opt-in: ?edit  OR  Cmd/Ctrl+E  OR  the toolbar button
    const wantEdit = new URLSearchParams(location.search).has('edit');
    const enableEditUI = () => {
      const bar = $('#cms-bar'); if (bar) bar.hidden = false;
      if (CONFIG.googleClientId) { if ($('#cms-signin')) $('#cms-signin').hidden = false; initSignIn(); }
      else if (CONFIG.tokenAuth) { promptForToken(); }
      else if (CONFIG.devNoauth) { if ($('#cms-edit')) $('#cms-edit').hidden = false; if ($('#cms-status')) $('#cms-status').textContent = 'dev mode — no auth (localhost)'; }
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
    // Exposed so @zms/capture can authenticate note-routing with the same
    // credential the editor uses (Google ID token or shared edit token).
    getToken: () => ID_TOKEN,
    getConfig: () => CONFIG,
  };
}

export default initZMS;
