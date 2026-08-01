// @platercms/core — framework-free in-place CMS editor.
//
// Renders content/site.json into the page and provides a Google-SSO-or-edit-token
// gated editor that commits edits back to git via /api/save. Site-specific bits
// (brand, token key, card templates, api base) are options.

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

// Same track-name grammar the server enforces (versions.js / save.js): a draft
// name becomes a directory, so it stays boring on purpose.
const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// The fixed set of page-level meta keys the editor exposes. Deliberately
// closed: these are the four that feeds, sitemaps and social cards read
// (see server-node/feed.js + sitemap.js), and an open-ended key/value editor
// would invite typos that silently do nothing.
const META_FIELDS = [
  ['title', 'Title', 'Shown in the browser tab and in search results'],
  ['description', 'Description', 'The one-sentence summary search + social cards show'],
  ['url', 'Site URL', 'Absolute origin, e.g. https://example.com — feeds and the sitemap need it'],
  ['image', 'Share image', 'Absolute or /path image used when the page is shared'],
];

/* ---------------- sitemap / review rail styles ---------------- */
// Injected on demand (like @platercms/capture) so consumer sites need no CSS changes.
// Palette matches the Plater edit-bar aesthetic: #1c1c1c bar, #333 hairlines,
// #c9a96e accent, #8a8277 muted.
const SMAP = 'plater-smap';
const SMAP_W = 264;   // drawer width; also `width` in the injected CSS below
// The drawer is an overlay below 900px (no body padding is reserved for it), so
// on a narrow screen it lies ON the page and swallows clicks meant for the
// bindings underneath. Anything over ~40% of the viewport is too much to open
// uninvited: phones (430 → 61%) start closed, tablets (768 → 34%) do not.
const smapCoversPage = () => {
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return vw > 0 && Math.min(SMAP_W, vw * 0.8) > vw * 0.4;
};
function injectSitemapStyles() {
  if (document.getElementById(`${SMAP}-style`)) return;
  const css = `
  .${SMAP}{position:fixed;left:0;z-index:49;width:${SMAP_W}px;max-width:80vw;bottom:0;overflow-y:auto;
    background:#161616;border-right:1px solid #2a2a2a;color:#e8e3d9;
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    transform:translateX(-100%);transition:transform .18s ease;box-shadow:8px 0 30px -18px rgba(0,0,0,.8)}
  .${SMAP}.open{transform:none}
  body.${SMAP}-open{transition:padding-left .18s ease}
  @media (min-width: 900px){ body.${SMAP}-open{padding-left:${SMAP_W}px} }
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
  .${SMAP}-drafts{flex:none;font:700 10px/1.6 ui-monospace,Menlo,monospace;color:#c9a96e;cursor:pointer;
    border:1px solid #3a352b;border-radius:4px;padding:0 5px}
  .${SMAP}-drafts:hover{background:#c9a96e;color:#151208}
  .${SMAP}-meta{padding:11px 14px 6px;border-top:1px solid #232323;margin-top:8px}
  .${SMAP}-meta h3{margin:0 0 7px;font:600 10px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.1em;
    text-transform:uppercase;color:#6d665c}
  .${SMAP}-meta label{display:block;margin:0 0 7px}
  .${SMAP}-meta label>span{display:block;font:600 10px/1.7 ui-monospace,Menlo,monospace;color:#8a8277}
  .${SMAP}-meta input{width:100%;box-sizing:border-box;background:#101010;border:1px solid #2f2b25;border-radius:4px;
    color:#e8e3d9;padding:4px 6px;font:13px/1.4 inherit}
  .${SMAP}-meta input:focus{outline:none;border-color:#c9a96e}
  .${SMAP}-meta input:disabled{opacity:.5;cursor:default}
  .${SMAP}-meta .hint{margin:2px 0 0;font:400 10px/1.5 inherit;color:#6d665c}
  .${SMAP}-foot{padding:10px 14px 14px;font:400 11px/1.5 inherit;color:#6d665c;border-top:1px solid #232323;margin-top:8px}
  .${SMAP}-toggle{background:#1b1813 !important;border:1px solid #3a352b !important;color:#c9a96e !important}
  .${SMAP}-toggle[aria-pressed="true"]{background:#c9a96e !important;color:#151208 !important;border-color:#c9a96e !important}
  `;
  const s = document.createElement('style'); s.id = `${SMAP}-style`; s.textContent = css;
  document.head.appendChild(s);
}

/* ---------------- edit-mode chrome (array controls + crash-buffer banner) ---------------- */
// Injected on demand, same as the sitemap styles. Two hard rules encoded here:
// chrome is invisible outside edit mode (the :not(.cms-editing) rule is the
// belt to the JS braces), and it never inherits the host site's fonts.
const EDNS = 'plater-ed';
const CTL = 'data-plater-ctl';
// Placeholder text for an empty binding is drawn by CSS from this attribute,
// never seeded as real text: a seeded "New item" sits in the DOM in front of
// the caret and gets committed as "New itemWidgets" the moment somebody types.
const PH = 'data-plater-ph';
function injectEditStyles() {
  if (document.getElementById(`${EDNS}-style`)) return;
  const css = `
  body:not(.cms-editing) [${CTL}]{display:none !important}
  .${EDNS}-ctl{display:inline-flex;gap:3px;margin-left:.45em;vertical-align:middle;white-space:nowrap;
    user-select:none;-webkit-user-select:none;opacity:.55;transition:opacity .12s ease}
  .${EDNS}-ctl:hover,*:hover > .${EDNS}-ctl,*:focus-within > .${EDNS}-ctl{opacity:1}
  .${EDNS}-ctl button,.${EDNS}-add button,.${EDNS}-banner button{background:#1c1c1c;border:1px solid #3a352b;
    color:#c9a96e;border-radius:4px;font:600 11px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:0 5px;min-width:20px;cursor:pointer;-webkit-appearance:none;appearance:none}
  .${EDNS}-ctl button:hover:not(:disabled),.${EDNS}-add button:hover{background:#c9a96e;color:#151208;border-color:#c9a96e}
  .${EDNS}-ctl button:disabled{opacity:.3;cursor:default}
  .${EDNS}-ctl button.rm:hover{background:#a5453a;border-color:#a5453a;color:#fff}
  .${EDNS}-ctl button.rm.armed{background:#a5453a;border-color:#a5453a;color:#fff}
  /* Placeholder for an empty binding. Generated content, so it is never part of
     textContent and can never be collected into site.json. */
  body.cms-editing .${EDNS}-ph::before{content:attr(${PH});color:#8a8277;font-style:italic;opacity:.8;
    pointer-events:none;-webkit-user-select:none;user-select:none}
  .${EDNS}-add{margin:.45rem 0 1rem;line-height:1}
  .${EDNS}-add button{padding:3px 11px;font-size:11px;letter-spacing:.06em}
  .${EDNS}-banner{position:fixed;top:12px;right:12px;z-index:2147483644;display:flex;gap:9px;align-items:center;
    /* top is re-set from JS to clear the edit bar — see positionBufferBanner */
    max-width:min(92vw,430px);padding:9px 11px;background:#1c1c1c;border:1px solid #333;border-radius:8px;
    color:#e8e3d9;font:13px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif;
    box-shadow:0 14px 40px -14px rgba(0,0,0,.85)}
  .${EDNS}-banner b{flex:none;color:#c9a96e;font:700 10px/1 ui-monospace,Menlo,monospace;
    letter-spacing:.1em;text-transform:uppercase}
  .${EDNS}-banner .msg{flex:1;min-width:0;color:#b8b0a4}
  .${EDNS}-banner button{padding:4px 9px;font-size:11px}
  .${EDNS}-banner button.discard{color:#8a8277;border-color:#333}
  .${EDNS}-barbtn{background:#1b1813 !important;border:1px solid #3a352b !important;color:#c9a96e !important}
  .${EDNS}-imgchip{position:fixed;z-index:2147483643;display:inline-flex;align-items:center;gap:6px;
    padding:5px 10px;background:rgba(28,28,28,.94);border:1px solid #3a352b;border-radius:6px;color:#c9a96e;
    font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;cursor:pointer;
    -webkit-appearance:none;appearance:none;box-shadow:0 10px 26px -14px rgba(0,0,0,.9)}
  .${EDNS}-imgchip:hover{background:#c9a96e;color:#151208;border-color:#c9a96e}
  .${EDNS}-imgchip[hidden]{display:none}
  .${EDNS}-imgfile{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0}
  body.cms-editing img.${EDNS}-imgover{outline:2px dashed #c9a96e;outline-offset:3px}
  `;
  const s = document.createElement('style'); s.id = `${EDNS}-style`; s.textContent = css;
  document.head.appendChild(s);
}

// Coarse on purpose: the crash-buffer banner only has to answer "is this mine
// from a minute ago, or something I abandoned last week?".
const relTime = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 75) return 'a moment ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

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

    $$('[data-list]').forEach(renderList);
    $$('[data-cards]').forEach(renderCards);

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
    syncMetaPanel();   // CONTENT just changed wholesale (restore, conflict merge, cancel)
  }

  /* ---------------- array rendering (one container at a time) ---------------- */
  // Split out of render() so a single container can be re-rendered after an
  // array mutation without blowing away the rest of the page (and the caret).

  const cardTemplateFor = (el, path) => el.querySelector('template')
    || (el.dataset.cardTemplate && document.querySelector(`#${el.dataset.cardTemplate}`))
    || (cardTemplates[path] && document.querySelector(cardTemplates[path]))
    || null;

  function renderList(el) {
    const path = el.dataset.list;
    const tag = el.dataset.listTag || 'p';
    const arr = getPath(CONTENT, path) || [];
    el.innerHTML = '';
    arr.forEach((item, i) => {
      const node = document.createElement(tag);
      // data-list is a text list, but sites do keep {label,…}-shaped objects in
      // one. Bind that object's first string field instead of stringifying the
      // object: collectEdits() would otherwise write "[object Object]" over the
      // whole entry the first time anything on the page is saved.
      if (item !== null && typeof item === 'object') {
        const key = Object.keys(item).find((k) => typeof item[k] === 'string');
        if (key) { node.textContent = item[key]; node.dataset.path = `${path}.${i}.${key}`; syncPlaceholder(node); }
      } else {
        node.textContent = item == null ? '' : String(item);
        node.dataset.path = `${path}.${i}`;
        syncPlaceholder(node);
      }
      if (EDITING) node.appendChild(itemControls(el, path, i, arr.length));
      el.appendChild(node);
    });
    if (EDITING) addAffordance(el, path);
  }

  function renderCards(el) {
    const path = el.dataset.cards;
    const arr = getPath(CONTENT, path) || [];
    const tmpl = cardTemplateFor(el, path);
    // No template means the authored HTML is the only shape we have; leave it
    // alone (and offer no controls — a mutation could not be re-rendered).
    if (!tmpl) return;
    [...el.children].forEach((c) => { if (c.tagName !== 'TEMPLATE') c.remove(); });
    arr.forEach((item, i) => {
      const frag = tmpl.content.cloneNode(true);
      frag.querySelectorAll('[data-field]').forEach((f) => {
        const key = f.dataset.field;
        if (item[key] == null) return;
        f.textContent = String(item[key]);
        f.dataset.path = `${path}.${i}.${key}`;
        syncPlaceholder(f);
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
      const root = frag.firstElementChild;
      if (EDITING && root) root.appendChild(itemControls(el, path, i, arr.length));
      el.appendChild(frag);
    });
    if (EDITING) addAffordance(el, path);
  }

  /* ---------------- array editing ---------------- */
  // Every [data-list] / [data-cards] container gets per-item ×/↑/↓ and one
  // "+ Add" in edit mode. All chrome carries the CTL attribute: it is stripped
  // from collected text, hidden by CSS outside .cms-editing, and deleted
  // outright when edit mode ends, so it can never reach site.json.

  const addNodes = new WeakMap(); // container -> its "+ Add" wrapper

  function itemControls(container, path, i, len) {
    const wrap = document.createElement('span');
    wrap.className = `${EDNS}-ctl`;
    wrap.setAttribute(CTL, '');
    wrap.setAttribute('contenteditable', 'false');
    const mk = (label, title, cls, fn, disabled) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.className = cls; b.disabled = Boolean(disabled);
      b.setAttribute(CTL, '');
      // The item around this button is contenteditable: a bare click would
      // first move the caret into it. Killing mousedown's default keeps the
      // selection (and the browser's undo stack) where the editor left it.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    wrap.append(
      mk('↑', 'Move up', 'up', () => mutate(container, path, (arr) => swap(arr, i, i - 1)), i === 0),
      mk('↓', 'Move down', 'down', () => mutate(container, path, (arr) => swap(arr, i, i + 1)), i === len - 1),
      rmButton(mk, container, path, i),
    );
    return wrap;
  }

  // × is the only destructive control here and it sits inline in the item's own
  // text flow — on a full-bleed row the geometric centre of the row can land on
  // it, so an ordinary click aimed at the end of a line deleted the item. It now
  // arms on the first click and only removes on a second, deliberate one; the
  // armed state times out on its own so a stray click leaves nothing behind.
  const ARM_MS = 4000;
  function rmButton(mk, container, path, i) {
    let armed = null;   // timer handle doubles as the armed flag
    let btn = null;
    const disarm = () => {
      clearTimeout(armed); armed = null;
      if (!btn) return;
      btn.classList.remove('armed');
      btn.textContent = '×';
      btn.title = 'Remove this item';
    };
    btn = mk('×', 'Remove this item', 'rm', () => {
      if (!armed) {
        btn.classList.add('armed');
        btn.textContent = '× ?';
        btn.title = 'Click again to remove this item';
        armed = setTimeout(disarm, ARM_MS);
        return;
      }
      disarm();
      mutate(container, path, (arr) => {
        if (i >= arr.length) return false;
        arr.splice(i, 1); return true;
      });
    });
    return btn;
  }

  function addAffordance(container, path) {
    const old = addNodes.get(container);
    if (old) old.remove();
    if (!container.parentNode) return;
    const wrap = document.createElement('div');
    wrap.className = `${EDNS}-add`;
    wrap.setAttribute(CTL, '');
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '+ Add'; b.setAttribute(CTL, '');
    b.title = 'Append a new item to this list';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      let at = -1;
      mutate(container, path, (arr) => {
        arr.push(container.dataset.cards != null ? blankCard(container, path) : blankListItem(arr));
        at = arr.length - 1;
        return true;
      });
      // Land the caret in the first editable field of the item just created.
      // Matched in JS, not with a selector: `tools.1` would also prefix-match
      // `tools.10`, and paths are author-supplied strings.
      if (at >= 0) {
        const p = `${path}.${at}`;
        focusEnd($$('[data-path]', container)
          .find((n) => n.dataset.path === p || n.dataset.path.startsWith(`${p}.`)));
      }
    });
    wrap.appendChild(b);
    container.parentNode.insertBefore(wrap, container.nextSibling);
    addNodes.set(container, wrap);
  }

  const swap = (arr, a, b) => {
    if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return false;
    [arr[a], arr[b]] = [arr[b], arr[a]];
    return true;
  };

  // A new card's shape comes from the template, not from a sibling. Every string
  // field starts EMPTY — a seeded "New item" would sit in front of the caret and
  // be committed as "New itemWidgets" the first time somebody typed. The hint is
  // drawn by CSS instead (see syncPlaceholder).
  function blankCard(container, path) {
    const tmpl = cardTemplateFor(container, path);
    const item = {};
    if (!tmpl) return item;
    tmpl.content.querySelectorAll('[data-field]').forEach((f) => { item[f.dataset.field] = ''; });
    tmpl.content.querySelectorAll('[data-field-link]').forEach((f) => { item[f.dataset.fieldLink] = ''; });
    return item;
  }

  // data-list arrays are usually strings but may hold objects; clone the shape
  // of element 0 rather than guessing, and never invent a URL.
  const LINKISH = /^(href|url|link|src|image|img|icon|to)$/i;
  function blankListItem(arr) {
    const first = arr[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return '';
    const out = {};
    for (const k of Object.keys(first)) {
      const v = first[k];
      out[k] = LINKISH.test(k) ? ''
        : typeof v === 'number' ? 0
        : typeof v === 'boolean' ? false
        : '';
    }
    return out;
  }

  // An empty binding has no height and no hint, so it reads as "nothing
  // happened". Show the hint as generated content keyed off an attribute:
  // ::before never enters textContent, so unlike seeded text it cannot be
  // typed in front of, collected, or committed.
  function syncPlaceholder(el) {
    const empty = elText(el) === '';
    el.classList.toggle(`${EDNS}-ph`, empty);
    if (!empty) { el.removeAttribute(PH); return; }
    // Name the field when we know it ("New name…"), otherwise stay generic —
    // the tail of a plain list path is an array index, not a label.
    const tail = (el.dataset.path || '').split('.').pop();
    const key = el.dataset.field || (/^\d+$/.test(tail) ? '' : tail);
    el.setAttribute(PH, key ? `New ${key}…` : 'New item…');
  }

  function mutate(container, path, fn) {
    // CRITICAL: text typed into a contenteditable exists only in the DOM until
    // something collects it, and the re-render below throws that DOM away. Sync
    // through the exact same collector the save path uses, first.
    collectEdits();
    let arr = getPath(CONTENT, path);
    if (!Array.isArray(arr)) { arr = []; setPath(CONTENT, path, arr); }
    if (fn(arr) === false) return;
    rerenderContainer(container);
    markDirty();
  }

  function rerenderContainer(el) {
    if (el.dataset.list != null) renderList(el);
    else if (el.dataset.cards != null) renderCards(el);
    if (EDITING) $$('[data-path]', el).forEach((n) => n.setAttribute('contenteditable', 'true'));
  }

  function focusEnd(el) {
    if (!el || !el.isContentEditable) return;
    try {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      // The controls span is the item's last child — collapsing to the node's
      // end would drop the caret behind it. Stop at the text instead.
      const ctl = el.querySelector(`[${CTL}]`);
      if (ctl) r.setEndBefore(ctl);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    } catch {}
  }

  /* ---------------- editing ---------------- */

  // Chrome lives inside editable items, so text collection has to ignore it —
  // otherwise "↑↓×" would be committed into site.json as copy.
  function elText(el) {
    if (!el.querySelector(`[${CTL}]`)) return el.textContent.trim();
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`[${CTL}]`).forEach((n) => n.remove());
    return clone.textContent.trim();
  }

  function collectEdits() {
    $$('[data-path]').forEach((el) => {
      setPath(CONTENT, el.dataset.path, elText(el));
    });
  }

  const isDirty = () => JSON.stringify(CONTENT) !== SAVED;

  // TOUCHED gates the unload guard. collectEdits() stringifies everything it
  // touches, so a number in site.json comes back as a string and CONTENT would
  // look "changed" on a page nobody edited — asking the guard whether the user
  // actually did something first keeps that from becoming a phantom warning.
  let TOUCHED = false;

  // Anything that changed CONTENT outside of typing routes through here.
  function markDirty() {
    TOUCHED = true;
    scheduleBufferWrite();
    if (DRAFT_TRACK) scheduleDraftAutosave();
    else if (EDITING && $('#cms-status') && isDirty()) $('#cms-status').textContent = 'editing — unsaved changes';
  }

  function setChrome(on) {
    // The image chip carries CTL too, so it is swept up here — drop the
    // reference to the image it was pointing at before the node goes.
    if (!on) {
      hideImgChip();
      $$(`[${CTL}]`).forEach((n) => n.remove());
      // Placeholders are chrome too — they are CSS-gated on .cms-editing, but
      // leaving the hooks behind would put them in @platercms/capture snapshots.
      $$(`[${PH}]`).forEach((n) => { n.removeAttribute(PH); n.classList.remove(`${EDNS}-ph`); });
      return;
    }
    injectEditStyles();
    // The re-render below reads CONTENT and throws the current DOM away, so
    // anything already typed has to be collected first (re-entrant callers:
    // a second setEditable(true), Restore).
    collectEdits();
    $$('[data-list]').forEach(renderList);
    $$('[data-cards]').forEach(renderCards);
  }

  // Chrome buttons live inside editable items and must stay non-editable, or a
  // stray keystroke could type into a control.
  function applyEditable(on) {
    $$('[data-path]').forEach((el) => {
      if (on) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
    if (on) $$(`.${EDNS}-ctl`).forEach((n) => n.setAttribute('contenteditable', 'false'));
  }

  function setEditable(on) {
    const was = EDITING;
    EDITING = on;
    if (on !== was) TOUCHED = false;
    document.body.classList.toggle('cms-editing', on);
    setChrome(on);
    applyEditable(on);
    setUnloadGuard(on);
    if (on) offerCrashBuffer(); else hideBufferBanner();
    syncMetaPanel();   // the meta inputs are only live while editing
    if ($('#cms-edit')) $('#cms-edit').hidden = on;
    // draft mode autosaves — hide the manual Save/Cancel pair to keep it simple
    if ($('#cms-save')) $('#cms-save').hidden = !on || Boolean(DRAFT_TRACK);
    if ($('#cms-cancel')) $('#cms-cancel').hidden = !on || Boolean(DRAFT_TRACK);
    if ($('#cms-status')) $('#cms-status').textContent = on
      ? (DRAFT_TRACK ? `editing the “${DRAFT_TRACK}” draft — every change autosaves` : 'editing — your changes are local until you Save')
      : 'signed in';
  }

  // every edit in draft mode schedules an autosave (input covers typing;
  // focusout catches the last field when you click away)
  document.addEventListener('input', (e) => { if (EDITING && DRAFT_TRACK && e.target.closest?.('[data-path]')) scheduleDraftAutosave(); }, true);
  document.addEventListener('focusout', (e) => { if (EDITING && DRAFT_TRACK && e.target.closest?.('[data-path]')) scheduleDraftAutosave(); }, true);
  // any typing feeds the crash buffer and arms the unsaved-edit guard
  document.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-path]');
    if (!EDITING || !el) return;
    // First keystroke into a blank item must drop the hint, and emptying a
    // field must bring it back — otherwise the hint sits behind live text.
    if (el.closest('[data-list],[data-cards]')) syncPlaceholder(el);
    TOUCHED = true;
    scheduleBufferWrite();
  }, true);

  /* ---------------- plain-text paste ---------------- */
  // site.json holds strings, not markup: pasting from a word processor or
  // another page must never smuggle HTML (styles, scripts, <img>) into a
  // binding. Capture phase + preventDefault on every editable target; the
  // clipboard's text/plain is the only thing that gets in. execCommand is
  // deprecated but is still the only cross-browser way to keep the native undo
  // stack intact, so it's tried first and hand-inserted only if it fails.
  document.addEventListener('paste', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-path]') : null;
    if (!el || !el.isContentEditable) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    if (!text) return;
    // Bindings are single strings; newlines would become <div>/<br> markup.
    const flat = text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').trim();
    let inserted = false;
    try { inserted = Boolean(document.execCommand && document.execCommand('insertText', false, flat)); } catch { inserted = false; }
    if (!inserted) {
      const sel = window.getSelection();
      // No caret (programmatic paste, some mobile keyboards): append a text
      // node rather than assigning textContent, which would wipe the controls.
      if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        el.insertBefore(document.createTextNode(flat), el.querySelector(`[${CTL}]`));
      } else {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const node = document.createTextNode(flat);
        r.insertNode(node);
        r.setStartAfter(node); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
  // drag-and-drop is the other HTML ingress; refuse it into bindings outright
  document.addEventListener('drop', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-path]') : null;
    if (el && el.isContentEditable) e.preventDefault();
  }, true);

  /* ---------------- unsaved-edit guard ---------------- */
  // Only armed while editing with real divergence from SAVED — an always-on
  // beforeunload is the kind of thing people learn to click through.

  const onBeforeUnload = (e) => {
    if (!EDITING || !TOUCHED) return;
    collectEdits();
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';       // required by Chrome/Safari to show the prompt
    return '';
  };

  function setUnloadGuard(on) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    // Draft mode autosaves every edit, so nothing is at risk there.
    if (on && !DRAFT_TRACK) window.addEventListener('beforeunload', onBeforeUnload);
  }

  /* ---------------- crash buffer ---------------- */
  // A tab that dies mid-edit (crash, phone backgrounded, accidental close)
  // used to lose everything typed since the last Save. Debounced snapshots go
  // to localStorage, keyed per page + track, and are offered back on the next
  // entry into edit mode. It is a recovery buffer, never a source of truth:
  // nothing is applied without a click, and any save/cancel clears it.

  // Lazy: DRAFT_TRACK is declared further down (const → TDZ at this point).
  const bufKey = () => `plater.buf.${slug(brand)}.${normalizePagePath(location.pathname)}${DRAFT_TRACK ? '.' + DRAFT_TRACK : ''}`;
  let bufTimer = null;
  let bufBanner = null;

  function scheduleBufferWrite() {
    clearTimeout(bufTimer);
    bufTimer = setTimeout(() => {
      if (!EDITING || !TOUCHED) return;
      collectEdits();
      try {
        if (!isDirty()) { localStorage.removeItem(bufKey()); return; }
        localStorage.setItem(bufKey(), JSON.stringify({ url: location.href, ts: Date.now(), content: CONTENT }));
      } catch {}   // quota / private mode: the buffer is a bonus, never a blocker
    }, 800);
  }

  function clearBuffer() {
    clearTimeout(bufTimer);
    try { localStorage.removeItem(bufKey()); } catch {}
    hideBufferBanner();
  }

  function readBuffer() {
    let raw = null;
    try { raw = localStorage.getItem(bufKey()); } catch { return null; }
    if (!raw) return null;
    try {
      const buf = JSON.parse(raw);
      if (!buf || typeof buf !== 'object' || !buf.content || typeof buf.content !== 'object') throw 0;
      return buf;
    } catch { try { localStorage.removeItem(bufKey()); } catch {} return null; }
  }

  function hideBufferBanner() {
    if (bufBanner) { bufBanner.remove(); bufBanner = null; }
    window.removeEventListener('resize', positionBufferBanner);
  }

  // The banner is fixed top-right and the edit bar is sticky at top:0, so with
  // a bare `top:12px` the banner lands ON the bar — covering #cms-status always
  // and, at widths where the bar wraps to two rows, the right-hand buttons
  // (Notes / History / ☰ Pages) too. Those are exactly the controls the user
  // reaches for while the banner is up, and a fixed overlay eats their clicks.
  // Measure the bar and sit below it (or above it, when the bar is a floated
  // bottom pill). Idempotent — safe to call on resize and after re-render.
  function positionBufferBanner() {
    if (!bufBanner) return;
    const bar = $('#cms-bar');
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!bar || bar.hidden) { bufBanner.style.top = '12px'; bufBanner.style.bottom = ''; return; }
    const r = bar.getBoundingClientRect();
    if (r.top > vh / 2) {   // bottom-pill bar: stack the banner above it
      bufBanner.style.top = '';
      bufBanner.style.bottom = Math.max(12, Math.round(vh - r.top + 10)) + 'px';
    } else {
      bufBanner.style.bottom = '';
      bufBanner.style.top = Math.max(12, Math.round(r.bottom + 10)) + 'px';
    }
  }

  function offerCrashBuffer() {
    hideBufferBanner();
    const buf = readBuffer();
    // Identical to what loaded = the buffer already made it to git; drop it.
    if (!buf || JSON.stringify(buf.content) === SAVED) { if (buf) clearBuffer(); return; }
    injectEditStyles();
    bufBanner = document.createElement('div');
    bufBanner.className = `${EDNS}-banner`;
    bufBanner.setAttribute(CTL, '');
    bufBanner.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.className = 'msg';
    label.append(Object.assign(document.createElement('b'), { textContent: 'Unsaved' }), ' ',
      `edits from ${relTime(Number(buf.ts) || Date.now())}`);
    const restore = document.createElement('button');
    restore.type = 'button'; restore.textContent = 'Restore'; restore.setAttribute(CTL, '');
    restore.addEventListener('click', () => {
      CONTENT = buf.content;
      render();   // EDITING is true here, so containers come back with controls
      applyEditable(true);
      clearBuffer();
      markDirty();
      if ($('#cms-status')) $('#cms-status').textContent = 'restored unsaved edits — Save to commit them';
    });
    const discard = document.createElement('button');
    discard.type = 'button'; discard.textContent = 'Discard'; discard.className = 'discard';
    discard.setAttribute(CTL, '');
    discard.addEventListener('click', clearBuffer);
    bufBanner.append(label, restore, discard);
    document.body.appendChild(bufBanner);
    positionBufferBanner();
    window.addEventListener('resize', positionBufferBanner);
  }

  /* ---------------- save conflicts ---------------- */
  // Two people (or a person and an agent) can commit between our load and our
  // Save. /api/save has already tried one refetch-and-retry server-side by the
  // time it answers 409 { error:'conflict' }, so this is a real race. Losing
  // what is on screen is the one unacceptable outcome: fetch the winner's file,
  // replay only the fields THIS session changed on top of it, and hand it back
  // still in edit mode for a human look before the second Save.
  //
  // Arrays are replayed whole rather than merged item-by-item — reconciling two
  // reorderings is a guess, and a guess here silently eats someone's work.
  // Deletions are not replayed either: the editor cannot delete keys, so a key
  // that exists only on their side is theirs, not ours to drop.
  function changedPaths(base, now, prefix = '', out = []) {
    const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (plain(base) && plain(now)) {
      for (const k of Object.keys(now)) changedPaths(base[k], now[k], prefix ? `${prefix}.${k}` : k, out);
      return out;
    }
    // collectEdits() reads the DOM, so a number in site.json comes back as a
    // string on a field nobody touched. Counting that as "changed" would replay
    // it over the other editor's version of the same field — the exact clobber
    // this whole path exists to avoid. Same text = not our edit.
    const prim = (v) => v === null || typeof v !== 'object';
    if (prim(base) && prim(now) && String(base ?? '') === String(now ?? '')) return out;
    if (JSON.stringify(base) !== JSON.stringify(now)) out.push(prefix);
    return out;
  }

  // Returns how many of the user's fields were replayed. Throws if the fresh
  // base can't be fetched — the caller then tells the truth instead of guessing.
  async function mergeAfterConflict() {
    const url = `${apiBase}/content${DRAFT_TRACK ? `?track=${encodeURIComponent(DRAFT_TRACK)}` : ''}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('content refetch ' + r.status);
    const fresh = await r.json();
    if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) throw new Error('unusable content response');
    const theirs = JSON.stringify(fresh);   // captured before the overlay mutates it
    const mine = changedPaths(JSON.parse(SAVED), CONTENT).filter(Boolean);
    for (const p of mine) setPath(fresh, p, getPath(CONTENT, p));
    CONTENT = fresh;
    SAVED = theirs;                          // their commit is now the base we diff against
    render();                                // EDITING is still true → controls come back
    applyEditable(EDITING);
    markDirty();
    return mine.length;
  }

  const setStatus = (msg) => { const s = $('#cms-status'); if (s) s.textContent = msg; };

  // Transport strings ("github write 422: {…}") answer a question nobody in the
  // editor asked. They go to the console; the status line answers the only
  // question that matters — is my writing safe, and what do I do now?
  function humanSaveError(status, out) {
    const raw = (out && out.error) || '';
    if (status === 401) return 'Sign-in expired — sign in again, then Save. Your edits are still here.';
    if (status === 403) return 'That account is not allowed to save this site.';
    if (status === 413) return 'This page is too large to save in one go.';
    if (status === 501 || /not configured/i.test(raw)) return 'Saving is not set up on this site yet — nothing was written.';
    if (status === 400) return 'The server rejected this content — nothing was saved.';
    if (/^github write/i.test(raw) || status === 502) return 'GitHub refused the write — nothing was saved. Try again in a moment.';
    return 'Save failed — nothing was lost. Try again.';
  }

  const CONFLICT_KEPT = (n) => `Someone else saved while you were editing — reloaded the latest, ` +
    `your edits are kept${n ? ` (${n} field${n === 1 ? '' : 's'})` : ''}. Review and Save again.`;
  const CONFLICT_LOST_BASE = 'Someone else saved while you were editing, and the latest copy could not be ' +
    'loaded. Copy anything you must keep, then reload the page.';

  // `retried` is passed only by the 401 recovery path below. It is never read
  // from the click listener's Event argument — see the `=== true` guard.
  async function save(retried) {
    collectEdits();
    if ($('#cms-status')) $('#cms-status').textContent = 'saving…';
    const headers = { 'content-type': 'application/json' };
    if (ID_TOKEN) headers.authorization = 'Bearer ' + ID_TOKEN;
    try {
      const r = await fetch(`${apiBase}/save`, { method: 'POST', headers, body: JSON.stringify({ content: CONTENT, ...(DRAFT_TRACK ? { track: DRAFT_TRACK } : {}) }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out.error) {
        // 409: their commit won the race. Keep the user in edit mode with both
        // sides present rather than making them choose between a reload and
        // their unsaved work.
        if (r.status === 409 && out.error === 'conflict') {
          console.warn('[plater] save conflict', out.message || '');
          try {
            const n = await mergeAfterConflict();
            setStatus(CONFLICT_KEPT(n));
          } catch (mergeErr) {
            console.warn('[plater] conflict merge failed', mergeErr);
            setStatus(CONFLICT_LOST_BASE);
          }
          return;
        }
        if (r.status === 401 && CONFIG.tokenAuth && !CONFIG.googleClientId) {
          // A cached token that the server rejects is indistinguishable from
          // no token to the editor, so it silently poisons every later save.
          // Drop it and ask again immediately, then retry once — otherwise
          // the only fix is clearing localStorage by hand.
          ID_TOKEN = null;
          try { localStorage.removeItem(tokenKey); } catch {}
          if (retried !== true) {
            promptForToken();
            if (ID_TOKEN) return save(true);
          }
        }
        console.warn('[plater] save failed', r.status, out.error || '');
        setStatus(humanSaveError(r.status, out));
        return;
      }
      SAVED = JSON.stringify(CONTENT);
      clearBuffer();   // it committed — the recovery copy is now noise
      const c = out.git && out.git.commit;
      // Order matters: setEditable(false) ends with an unconditional 'signed in'
      // on the status line, so a confirmation written before it is overwritten
      // in the same task and never paints — the user never learns the write
      // reached git. Leave the bar, then say what happened.
      setEditable(false);
      setStatus(c ? `saved & committed ${c}` : 'saved');
      // a save can change what a page shows → review hashes may have flipped
      refreshSitemap().catch(() => {});
      if (typeof onSaved === 'function') onSaved(CONTENT, out);
    } catch (e) {
      console.warn('[plater] save error', e);
      setStatus('Could not reach the server — nothing was saved, your edits are still here.');
    }
  }

  function cancel() {
    CONTENT = JSON.parse(SAVED);
    clearBuffer();   // discarded on purpose — don't offer it back next time
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

  /* ---------------- first-visit setup ---------------- */
  // A site with no GOOGLE_CLIENT_ID and no CMS_EDIT_TOKEN cannot authenticate
  // anybody, so the sign-in affordance is dead markup and "not configured" is a
  // dead end. This panel is what ?edit shows instead: the same env checklist
  // `plater doctor` prints, one line each, and the exact link for the one piece
  // that has to be minted by hand. Nothing here is an error — it is the last
  // step of an install, addressed to the person who can finish it.

  // Wording is kept in sync with cli/plater.js's ENV table on purpose: the
  // person reading this panel is the person who just ran doctor.
  const SETUP_ENV = [
    ['CMS_ADMIN_EMAIL', 'the Google account allowed to edit — you@example.com', true],
    ['CMS_EDIT_TOKEN', 'a long random string; sign in with it from an iPad without Google', true],
    ['GITHUB_TOKEN', 'fine-grained PAT with contents:write on the repo below', true],
    ['GITHUB_REPOSITORY', 'org/repo this site commits to', true],
    ['GOOGLE_CLIENT_ID', 'optional — adds Google sign-in alongside the token', false],
    ['GITHUB_BRANCH', 'optional — the branch saves commit to (default main)', false],
    ['GITHUB_EDIT_PATH', 'optional — the content file (default web/content/site.json)', false],
    ['CMS_SITE_NAME', 'optional — short name used in commit messages', false],
  ];
  const PAT_URL = 'https://github.com/settings/personal-access-tokens/new';

  function setupPanel() {
    if (document.getElementById('plater-setup')) return;
    const wrap = document.createElement('div');
    wrap.id = 'plater-setup';
    // Deliberately NOT marked with CTL: this panel shows when edit mode can
    // never be entered, and the CTL rule hides everything outside .cms-editing.
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    wrap.innerHTML = `<style>
#plater-setup{position:fixed;right:16px;bottom:16px;z-index:2147483645;width:min(94vw,430px);max-height:min(78vh,660px);
  overflow:auto;background:#151412;border:1px solid #332f28;border-radius:10px;color:#e8e3d9;
  font:13px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 26px 60px -22px rgba(0,0,0,.9)}
#plater-setup .ps-hd{position:sticky;top:0;display:flex;gap:10px;align-items:baseline;padding:13px 16px;
  background:#191712;border-bottom:1px solid #2f2b25}
#plater-setup .ps-hd b{color:#c9a96e;font:700 11px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}
#plater-setup .ps-x{margin-left:auto;background:none;border:1px solid #3a352b;color:#b8b0a4;border-radius:5px;
  padding:2px 8px;cursor:pointer;font:12px/1.4 inherit}
#plater-setup .ps-bd{padding:14px 16px 18px}
#plater-setup p{margin:0 0 12px;color:#b8b0a4}
#plater-setup .lede{color:#e8e3d9}
#plater-setup ul{list-style:none;margin:0 0 14px;padding:0}
#plater-setup li{padding:7px 0;border-bottom:1px solid #232019}
#plater-setup li:last-child{border-bottom:0}
#plater-setup code{display:block;font:600 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9a96e}
#plater-setup li.opt code{color:#8a8277}
#plater-setup .d{color:#8a8277;font-size:12px}
#plater-setup a{color:#c9a96e}
#plater-setup .ps-cta{display:inline-block;margin:2px 0 12px;padding:7px 13px;background:#c9a96e;color:#151208;
  border-radius:6px;font-weight:700;text-decoration:none}
#plater-setup .ps-cta:hover{background:#e0c48d}
#plater-setup .ps-foot{color:#6d665c;font-size:12px}
</style>
<div class="ps-hd"><b>Finish setting up ${esc(brand)}</b><button class="ps-x" type="button">✕</button></div>
<div class="ps-bd">
<p class="lede">The page is wired and the editor is loaded — it just has no credentials yet, so there is nobody it can let in. Set these where the site is deployed (Vercel → Settings → Environment Variables, or your <code style="display:inline">.env</code>), redeploy, and this panel gives way to the editor.</p>
<a class="ps-cta" href="${PAT_URL}" target="_blank" rel="noopener">Mint the GitHub token →</a>
<p class="d">Fine-grained, this repo only, <b>Contents: Read and write</b>. That token is what turns a save into a commit.</p>
<ul>${SETUP_ENV.map(([k, d, req]) => `<li class="${req ? 'req' : 'opt'}"><code>${esc(k)}</code><span class="d">${esc(d)}</span></li>`).join('')}</ul>
<p class="ps-foot">One of <code style="display:inline">CMS_EDIT_TOKEN</code> or <code style="display:inline">GOOGLE_CLIENT_ID</code> is enough to sign in; the GitHub pair is what makes saves durable. Run <code style="display:inline">plater doctor</code> to check the whole list at once.</p>
</div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.ps-x').onclick = () => wrap.remove();
  }

  /* ---------------- sitemap + review rail ---------------- */
  // Edit-mode left sidebar: outline of the site's pages (from GET api/review),
  // click to navigate (preserving ?edit), with persistent per-page review
  // state. Checkboxes appear only for pushed-but-unreviewed pages; reviewed
  // pages show a subtle done tick instead.

  let smapEl = null;
  let smapMetaEl = null;
  let smapToggle = null;
  let smapStatus = null; // last fetched review status payload
  let smapAvailable = false;
  let versionTracks = null; // { track: [slugs] } from /api/versions (null = endpoint absent)

  const slugForPage = (p) => {
    const out = String(p || '/').replace(/^\/+|\/+$/g, '').replace(/\.html$/i, '').replace(/\//g, '__');
    return out || 'index';
  };

  async function fetchVersionTracks() {
    try {
      const r = await fetch(`${apiBase}/versions`, { cache: 'no-store' });
      if (!r.ok) return null;
      const data = await r.json();
      return data && data.tracks ? data.tracks : null;
    } catch { return null; }
  }

  // Full-screen reader: every track's draft of one page, side by side.
  // Read-and-choose UX — applying a winner goes through the normal edit
  // paths (inline edit / agent note), never a blind overwrite.
  async function openVersions(pagePath) {
    const slug = slugForPage(pagePath);
    const tracks = Object.keys(versionTracks || {}).filter((t) => (versionTracks[t] || []).includes(slug));
    if (!tracks.length) return;
    const drafts = [];
    for (const t of tracks) {
      try {
        const r = await fetch(`${apiBase}/versions?track=${encodeURIComponent(t)}&page=${encodeURIComponent(pagePath)}`, { cache: 'no-store' });
        if (r.ok) drafts.push(await r.json());
      } catch {}
    }
    if (!drafts.length) return;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const old = document.getElementById('plater-versions');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'plater-versions';
    wrap.innerHTML = `<style>
#plater-versions{position:fixed;inset:0;z-index:2147483646;background:rgba(12,11,9,.96);color:#e8e3d9;overflow:auto;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
#plater-versions .pv-bar{position:sticky;top:0;display:flex;gap:12px;align-items:baseline;padding:14px 20px;background:#191712;border-bottom:1px solid #2f2b25}
#plater-versions .pv-bar b{color:#c9a96e;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
#plater-versions .pv-close{margin-left:auto;background:none;border:1px solid #3a352b;color:#e8e3d9;padding:5px 12px;border-radius:6px;cursor:pointer}
#plater-versions .pv-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1px;background:#2f2b25}
#plater-versions .pv-col{background:#141310;padding:22px 26px;min-width:0}
#plater-versions .pv-col h2.pv-t{font:700 12px/1 ui-monospace,Menlo,monospace;color:#c9a96e;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px}
#plater-versions .pv-col .pv-m{font:11px/1.5 ui-monospace,Menlo,monospace;color:#7a736a;margin:0 0 18px}
#plater-versions .pv-body{white-space:pre-wrap;word-wrap:break-word;font:15px/1.65 ui-serif,Georgia,serif;color:#ddd6c9}
</style>
<div class="pv-bar"><b>Drafts · ${esc(pagePath)}</b><span style="color:#7a736a;font-size:12px">read, compare — apply the winner with inline edit or a note to the agent</span><button class="pv-close">✕ close</button></div>
<div class="pv-cols">${drafts.map((d) => `<div class="pv-col"><h2 class="pv-t">${esc(d.track)}</h2><p class="pv-m">${esc(d.source || '')}${d.generated_at ? ' · ' + esc(d.generated_at) : ''}</p><div class="pv-body">${esc(d.body || '')}</div></div>`).join('')}</div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.pv-close').onclick = () => wrap.remove();
  }

  /* ---------------- history + restore ---------------- */
  // Every Plater save is a real commit, so "undo" already exists in git — this
  // panel is the editor's window onto it. Restore is itself a new commit (never
  // a revert or a force-push), so the timeline only ever grows: the sentence in
  // the status line says exactly that, because "restore" reads destructive.

  const authHeaders = () => (ID_TOKEN ? { authorization: 'Bearer ' + ID_TOKEN } : {});
  const contentEndpoint = () => `${apiBase}/content${DRAFT_TRACK ? `?track=${encodeURIComponent(DRAFT_TRACK)}` : ''}`;
  // History is scoped to the file being edited, exactly like save: inside a
  // draft it lists and restores THAT track's overlay, never the live page.
  const trackParam = () => (DRAFT_TRACK ? `&track=${encodeURIComponent(DRAFT_TRACK)}` : '');
  const trackBody = () => (DRAFT_TRACK ? { track: DRAFT_TRACK } : {});

  let historyBtn = null;

  function mountHistoryButton() {
    if (historyBtn && historyBtn.isConnected) return;
    const bar = $('#cms-bar');
    if (!bar) return;
    injectEditStyles();
    historyBtn = document.createElement('button');
    historyBtn.type = 'button';
    historyBtn.id = 'cms-history';
    historyBtn.className = `${EDNS}-barbtn`;
    historyBtn.textContent = '⟲ History';
    historyBtn.title = DRAFT_TRACK
      ? `Past saves of the “${DRAFT_TRACK}” draft — read them, restore any one`
      : 'Past saves of this content — read them, restore any one';
    historyBtn.addEventListener('click', () => { openHistory().catch(() => {}); });
    bar.insertBefore(historyBtn, bar.querySelector('#cms-status'));
  }

  // One line, no transport strings: the panel is read by someone deciding
  // whether their writing is safe, not debugging an API.
  function historyUnavailable(status) {
    if (status === 401 || status === 403) return 'Sign in again to see the history of this content.';
    if (status === 501) return 'This site is not backed by git yet, so there is no history to restore from — saves here write a file, not a commit.';
    if (status === 404 || status === 405) return 'History is not switched on for this site yet — nothing is missing, the feature just is not installed here.';
    return 'The list of past saves could not be loaded — nothing was changed.';
  }

  function historyShell() {
    const old = document.getElementById('plater-history');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'plater-history';
    wrap.innerHTML = `<style>
#plater-history{position:fixed;inset:0;z-index:2147483646;background:rgba(12,11,9,.96);color:#e8e3d9;overflow:auto;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
#plater-history .ph-bar{position:sticky;top:0;display:flex;gap:12px;align-items:baseline;padding:14px 20px;background:#191712;border-bottom:1px solid #2f2b25}
#plater-history .ph-bar b{color:#c9a96e;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
#plater-history .ph-bar .ph-sub{color:#7a736a;font-size:12px}
#plater-history .ph-close{margin-left:auto;background:none;border:1px solid #3a352b;color:#e8e3d9;padding:5px 12px;border-radius:6px;cursor:pointer}
#plater-history .ph-body{max-width:860px;margin:0 auto;padding:22px 20px 60px;color:#b8b0a4;font-size:14px}
#plater-history .ph-row{display:flex;gap:14px;align-items:baseline;padding:13px 2px;border-bottom:1px solid #232019}
#plater-history .ph-main{flex:1;min-width:0}
#plater-history .ph-msg{color:#e8e3d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#plater-history .ph-meta{font:11px/1.6 ui-monospace,Menlo,monospace;color:#7a736a}
#plater-history .ph-sha{font:600 11px/1.6 ui-monospace,Menlo,monospace;color:#c9a96e}
#plater-history .ph-restore{flex:none;background:none;border:1px solid #3a352b;color:#c9a96e;border-radius:5px;
  padding:4px 11px;font:600 11px/1.5 ui-monospace,Menlo,monospace;cursor:pointer}
#plater-history .ph-restore:hover:not(:disabled){background:#c9a96e;color:#151208;border-color:#c9a96e}
#plater-history .ph-restore:disabled{opacity:.4;cursor:default}
</style>
<div class="ph-bar"><b>History</b><span class="ph-sub"></span><button class="ph-close">✕ close</button></div>
<div class="ph-body"></div>`;
    // textContent, not interpolated markup — the track name is user-typed.
    // In draft mode this line is the whole promise: the panel is scoped.
    wrap.querySelector('.ph-sub').textContent = DRAFT_TRACK
      ? `saves of the “${DRAFT_TRACK}” draft only — restoring one rewrites the draft, never the live page`
      : 'every save is a commit — restoring one writes it back as a new save, so nothing is ever lost';
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    wrap.querySelector('.ph-close').onclick = close;
    document.addEventListener('keydown', onKey);
    wrap.close = close;
    return wrap;
  }

  async function openHistory() {
    const wrap = historyShell();
    const body = wrap.querySelector('.ph-body');
    body.textContent = 'Loading the last 30 saves…';
    // A GET that carries author emails is authenticated like the write leg, so
    // ask for the token here rather than showing an unexplained sign-in error.
    if (!ID_TOKEN && CONFIG.tokenAuth && !CONFIG.googleClientId) promptForToken();
    let r, out;
    try {
      r = await fetch(`${apiBase}/history?limit=30${trackParam()}`, { headers: authHeaders(), cache: 'no-store' });
      out = await r.json().catch(() => ({}));
    } catch (e) {
      console.warn('[plater] history load failed', e);
      body.textContent = 'Could not reach the server — the history could not be loaded.';
      return;
    }
    if (!r.ok || out.error) {
      console.warn('[plater] history unavailable', r.status, out.error || '');
      body.textContent = historyUnavailable(r.status);
      return;
    }
    const commits = Array.isArray(out.commits) ? out.commits : [];
    if (!commits.length) {
      body.textContent = DRAFT_TRACK
        ? `The “${DRAFT_TRACK}” draft has no committed saves yet — its own history starts once a draft save is committed.`
        : 'No saved versions yet — your first Save starts this list.';
      return;
    }
    renderHistory(body, commits, wrap);
  }

  // Built as DOM, not innerHTML: commit messages are arbitrary text from git.
  function renderHistory(body, commits, wrap) {
    body.textContent = '';
    for (const c of commits) {
      const sha = String(c.sha || '');
      const short = sha.slice(0, 7);
      const row = document.createElement('div');
      row.className = 'ph-row';
      const main = document.createElement('div');
      main.className = 'ph-main';
      const msg = document.createElement('div');
      msg.className = 'ph-msg';
      msg.textContent = String(c.message || '').split('\n')[0] || '(no message)';
      const meta = document.createElement('div');
      meta.className = 'ph-meta';
      const when = c.date ? Date.parse(c.date) : NaN;
      meta.append(
        `${c.author || 'unknown'} · ${Number.isNaN(when) ? String(c.date || 'date unknown') : relTime(when)} · `,
        Object.assign(document.createElement('span'), { className: 'ph-sha', textContent: short }),
      );
      main.append(msg, meta);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ph-restore'; btn.textContent = 'Restore';
      btn.title = `Put the content from ${short} back — as a new save`;
      btn.addEventListener('click', () => restoreCommit(sha, btn, wrap));
      row.append(main, btn);
      body.appendChild(row);
    }
  }

  function humanRestoreError(status) {
    if (status === 401 || status === 403) return 'Sign in again to restore — nothing was changed.';
    if (status === 404) return 'That version no longer has this content file — nothing was changed.';
    if (status === 422) return 'That version of the content is unreadable, so it was not restored — nothing was changed.';
    if (status === 501) return 'Restoring is not set up on this site — nothing was changed.';
    return 'The restore did not go through — nothing was changed. Try again.';
  }

  async function restoreCommit(sha, btn, wrap) {
    const short = sha.slice(0, 7);
    // The one thing a person could lose here is what is on screen right now,
    // so say so before asking — the git side genuinely loses nothing.
    let warn = '';
    if (EDITING && TOUCHED) { collectEdits(); if (isDirty()) warn = '\n\nYour unsaved edits on this page will be replaced.'; }
    const what = DRAFT_TRACK ? `the “${DRAFT_TRACK}” draft` : 'the content';
    if (!window.confirm(`Restore ${what} from ${short}?\n\nThis puts the old version back as a NEW save — the history keeps growing, so you can restore your way back too.${DRAFT_TRACK ? '\n\nThe live page is not touched.' : ''}${warn}`)) return;
    if (!ID_TOKEN && CONFIG.tokenAuth && !CONFIG.googleClientId) { promptForToken(); if (!ID_TOKEN) return; }
    btn.disabled = true; btn.textContent = 'restoring…';
    try {
      const r = await fetch(`${apiBase}/history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ restore: sha, ...trackBody() }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out.error || !out.ok) {
        console.warn('[plater] restore failed', r.status, out.error || '');
        btn.disabled = false; btn.textContent = 'Restore';
        setStatus(humanRestoreError(r.status));
        return;
      }
      const fresh = await fetch(contentEndpoint(), { cache: 'no-store' }).then((c) => c.json());
      if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) throw new Error('unusable content response');
      CONTENT = fresh;
      SAVED = JSON.stringify(CONTENT);
      clearBuffer();          // the pre-restore buffer is not something to offer back
      TOUCHED = false;
      render();
      applyEditable(EDITING);
      if (wrap && wrap.close) wrap.close();
      setStatus(DRAFT_TRACK
        ? `Restored the “${DRAFT_TRACK}” draft from ${short} — a new draft save; the live page is untouched.`
        : `Restored content from ${short} — this is itself a new save, nothing was lost.`);
      refreshSitemap().catch(() => {});
    } catch (e) {
      // The commit landed; only the reload of it failed. Never claim a loss.
      console.warn('[plater] restore refetch failed', e);
      btn.disabled = false; btn.textContent = 'Restore';
      setStatus(`Restored from ${short}, but this page could not reload it — refresh to see the restored content.`);
    }
  }

  /* ---------------- image replace ---------------- */
  // In edit mode an <img> whose src is bound to content gets a "Replace image"
  // chip on hover (and accepts a dropped file). The upload is committed by
  // /api/upload; only the returned URL goes into CONTENT, so the src change
  // rides the normal Save like any other edit.

  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
  const IMG_MAX = 4 * 1024 * 1024;
  const OVER = `${EDNS}-imgover`;

  // render() reads data-bind-attr as "path:attr", and templates are authored
  // that way — but "src:path" is the order people write from memory. Accept
  // either, and tolerate a comma-separated list of pairs.
  function boundSrcPath(el) {
    const spec = el.getAttribute && el.getAttribute('data-bind-attr');
    if (!spec) return null;
    for (const pair of spec.split(',')) {
      const [a, b] = pair.trim().split(':').map((s) => s.trim());
      if (!a || !b) continue;
      if (b.toLowerCase() === 'src') return a;
      if (a.toLowerCase() === 'src') return b;
    }
    return null;
  }

  const bindableImg = (t) => {
    const img = t instanceof Element ? t.closest('img[data-bind-attr]') : null;
    return img && boundSrcPath(img) ? img : null;
  };

  let imgChip = null;
  let imgFile = null;
  let imgTarget = null;
  let pickFor = null;

  function ensureImgChip() {
    if (imgChip && imgChip.isConnected) return imgChip;
    injectEditStyles();
    imgChip = document.createElement('button');
    imgChip.type = 'button';
    imgChip.className = `${EDNS}-imgchip`;
    imgChip.textContent = '⤢ Replace image';
    imgChip.title = 'Upload a new image — or drop one straight onto the picture';
    imgChip.setAttribute(CTL, '');
    imgChip.hidden = true;
    imgChip.addEventListener('mousedown', (e) => e.preventDefault());
    imgChip.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (imgTarget) pickImageFor(imgTarget);
    });
    document.body.appendChild(imgChip);
    return imgChip;
  }

  function positionImgChip() {
    if (!imgChip || imgChip.hidden || !imgTarget || !imgTarget.isConnected) return;
    const r = imgTarget.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { hideImgChip(); return; }
    const w = imgChip.offsetWidth || 130;
    // Small images can't hold the chip: park it just below instead of over it.
    const inside = r.width > w + 16 && r.height > 40;
    imgChip.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, r.left + 8))}px`;
    imgChip.style.top = `${Math.max(6, inside ? r.top + 8 : r.bottom + 4)}px`;
  }

  function showImgChip(img) {
    ensureImgChip();
    imgTarget = img;
    imgChip.hidden = false;
    positionImgChip();
  }

  function hideImgChip() {
    imgTarget = null;
    if (imgChip) imgChip.hidden = true;
  }

  // Delegated so it keeps working across every array re-render.
  document.addEventListener('mouseover', (e) => {
    if (!EDITING) return;
    const t = e.target;
    if (imgChip && t instanceof Node && imgChip.contains(t)) return;   // moving onto the chip itself
    const img = bindableImg(t);
    if (img) showImgChip(img); else hideImgChip();
  }, true);
  window.addEventListener('scroll', positionImgChip, true);
  window.addEventListener('resize', positionImgChip);

  function pickImageFor(img) {
    if (!imgFile || !imgFile.isConnected) {
      imgFile = document.createElement('input');
      imgFile.type = 'file';
      imgFile.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
      imgFile.className = `${EDNS}-imgfile`;
      imgFile.setAttribute(CTL, '');
      imgFile.addEventListener('change', () => {
        const f = imgFile.files && imgFile.files[0];
        const target = pickFor;
        imgFile.value = '';           // picking the same file twice must re-fire
        if (f && target) uploadImageFor(target, f);
      });
      document.body.appendChild(imgFile);
    }
    pickFor = img;
    imgFile.click();
  }

  // Files are the only drag payload we take; anything else falls through to the
  // browser (and to the [data-path] drop refusal above).
  const hasFiles = (dt) => Boolean(dt && [...(dt.types || [])].includes('Files'));

  document.addEventListener('dragover', (e) => {
    if (!EDITING) return;
    const img = bindableImg(e.target);
    if (!img || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    img.classList.add(OVER);
    showImgChip(img);
  }, true);
  document.addEventListener('dragleave', (e) => {
    const img = bindableImg(e.target);
    if (img) img.classList.remove(OVER);
  }, true);
  document.addEventListener('drop', (e) => {
    if (!EDITING) return;
    const img = bindableImg(e.target);
    if (!img || !hasFiles(e.dataTransfer)) return;
    // Unconditional: letting the browser open the dropped file would navigate
    // away from a page full of unsaved edits.
    e.preventDefault();
    img.classList.remove(OVER);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadImageFor(img, f);
  }, true);

  const readBase64 = (file) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(fr.error || new Error('read failed'));
    fr.onload = () => res(String(fr.result || '').replace(/^data:[^,]*,/, ''));
    fr.readAsDataURL(file);
  });

  function humanUploadError(status, name) {
    if (status === 401) return 'Sign-in expired — sign in again, then replace the image.';
    if (status === 403) return 'That account is not allowed to add images to this site.';
    if (status === 413) return `“${name}” is too large — 4 MB is the limit.`;
    if (status === 400) return `The server would not accept “${name}” — try a PNG or JPG.`;
    if (status === 404 || status === 405 || status === 501) return 'Image upload is not set up on this site yet — nothing was uploaded.';
    if (status === 502) return 'GitHub refused the upload — nothing was changed. Try again in a moment.';
    return `“${name}” could not be uploaded — nothing was changed.`;
  }

  async function uploadImageFor(img, file) {
    const path = boundSrcPath(img);
    if (!path) return;
    const name = file.name || 'image';
    // Client-side mirror of the server's allowlist and cap: a 20 MB photo
    // should fail in a sentence, not after a minute of uploading.
    if (!IMG_EXT.test(name)) { setStatus(`“${name}” is not an image this site can use — PNG, JPG, GIF, WebP or SVG only.`); return; }
    if (file.size > IMG_MAX) {
      setStatus(`“${name}” is ${(file.size / 1048576).toFixed(1)} MB — images have to be 4 MB or smaller.`);
      return;
    }
    if (!ID_TOKEN && !CONFIG.devNoauth) {
      promptForToken();
      if (!ID_TOKEN) { setStatus('Sign in first — the image was not uploaded.'); return; }
    }
    hideImgChip();
    setStatus(`Uploading “${name}”…`);
    let dataBase64;
    try { dataBase64 = await readBase64(file); }
    catch (e) { console.warn('[plater] image read failed', e); setStatus(`Could not read “${name}” from your device — nothing was uploaded.`); return; }
    try {
      const r = await fetch(`${apiBase}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ filename: name, dataBase64 }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out.error || !out.url) {
        console.warn('[plater] upload failed', r.status, out.error || '');
        setStatus(humanUploadError(r.status, name));
        return;
      }
      // Same rule as every other re-render: collect what is typed before
      // render() throws the current DOM away.
      collectEdits();
      setPath(CONTENT, path, out.url);
      render();
      applyEditable(EDITING);
      markDirty();
      setStatus(DRAFT_TRACK
        ? `“${name}” is in — the draft autosaves.`
        : `“${name}” is in place — Save to publish it.`);
    } catch (e) {
      console.warn('[plater] upload error', e);
      setStatus('Could not reach the server — the image was not uploaded.');
    }
  }

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
        const nTracks = versionTracks ? Object.keys(versionTracks).filter((t) => (versionTracks[t] || []).includes(slugForPage(norm))).length : 0;
        if (nTracks) html += `<span class="${SMAP}-drafts" data-versions="${esc(norm)}" title="${nTracks} alternate draft${nTracks > 1 ? 's' : ''} — click to read side by side">${nTracks}✎</span>`;
        html += `</a>`;
      }
      html += `</div>`;
    }
    html += `<div class="${SMAP}-foot">Click a page to open it in edit mode. ` +
      `Tick the box once you’ve read it — edits after review flip it back automatically.` +
      `${counts.total ? ' Press <b>r</b> to mark this page reviewed.' : ''}</div>`;
    // Setting innerHTML detaches the meta panel, which blurs whatever is being
    // typed into it (a review tick can land mid-sentence). Re-attach the SAME
    // node and put the caret back where it was.
    const meta = buildMetaPanel();
    const focused = meta.contains(document.activeElement) ? document.activeElement : null;
    const caret = focused ? [focused.selectionStart, focused.selectionEnd] : null;
    smapEl.innerHTML = html;
    smapEl.insertBefore(meta, smapEl.querySelector(`.${SMAP}-foot`));
    syncMetaPanel();
    if (focused) {
      focused.focus();
      try { focused.setSelectionRange(caret[0], caret[1]); } catch {}
    }

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
    smapEl.querySelectorAll(`[data-versions]`).forEach((badge) => {
      badge.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        openVersions(badge.dataset.versions);
      });
    });
  }

  /* ---------------- page meta ---------------- */
  // CONTENT.meta is the part of a page nobody can see and everybody reads: the
  // tab title, the search snippet, the share card. It has no place on the page
  // itself, so it lives at the foot of the Pages drawer as four small inputs
  // writing straight into CONTENT — dirty-tracked exactly like inline text, so
  // the same Save commits them.
  //
  // The node is built ONCE and re-appended after each renderSitemap(), which
  // replaces smapEl.innerHTML: keeping the same element keeps whatever is
  // half-typed in it (and, below, the caret).
  function buildMetaPanel() {
    if (smapMetaEl) return smapMetaEl;
    const el = document.createElement('div');
    el.className = `${SMAP}-meta`;
    const h = document.createElement('h3');
    h.textContent = 'Page meta';
    el.appendChild(h);
    for (const [key, label, hint] of META_FIELDS) {
      const wrap = document.createElement('label');
      wrap.append(Object.assign(document.createElement('span'), { textContent: label }));
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.meta = key;
      input.placeholder = key === 'url' ? 'https://…' : `add a ${label.toLowerCase()}`;
      input.title = hint;
      // Written on every keystroke so a drawer closed mid-edit still saves.
      input.addEventListener('input', () => {
        const v = input.value.trim();
        const meta = (CONTENT.meta ??= {});
        // An emptied field is a removal, not an empty string: a blank
        // description in a share card is worse than none at all.
        if (v) meta[key] = v; else delete meta[key];
        if (key === 'title' && v) document.title = v;
        markDirty();
      });
      wrap.appendChild(input);
      el.appendChild(wrap);
    }
    el.appendChild(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: 'Never shown on the page — this is what the browser tab, search results and share cards read.',
    }));
    smapMetaEl = el;
    return el;
  }

  // Values come from CONTENT on every paint EXCEPT for the field being typed
  // into, which would otherwise fight the caret.
  function syncMetaPanel() {
    if (!smapMetaEl) return;
    const meta = (CONTENT && CONTENT.meta) || {};
    const editable = EDITING;
    smapMetaEl.querySelectorAll('[data-meta]').forEach((input) => {
      if (document.activeElement !== input) input.value = meta[input.dataset.meta] ?? '';
      input.disabled = !editable;
    });
    const hint = smapMetaEl.querySelector('.hint');
    if (hint) hint.textContent = editable
      ? 'Never shown on the page — this is what the browser tab, search results and share cards read.'
      : 'Open Edit page to change these — they set the tab title, search snippet and share card.';
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
    [smapStatus, versionTracks] = await Promise.all([fetchReviewStatus(), fetchVersionTracks()]);
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

    // Restore open state across in-edit-mode navigation. No stored choice means
    // first run: open by default only where the drawer doesn't lie over the
    // page — on a phone it would blanket the bindings the user came to edit.
    let restore = null;
    try { restore = sessionStorage.getItem(`${SMAP}.open`); } catch {}
    if (restore === null ? !smapCoversPage() : restore !== '0') setSitemapOpen(true);
  }

  async function refreshSitemap() {
    if (!smapAvailable) return;
    const fresh = await fetchReviewStatus();
    if (fresh) { smapStatus = fresh; renderSitemap(); }
  }

  /* ---------------- boot ---------------- */

  // ?draft=<track> flips the WHOLE PAGE onto that track's content overlay,
  // fully rendered in place. Editing + saving in draft mode writes the track's
  // overlay file (a git commit like any other) — the live copy is untouched
  // until you promote a draft by saving without ?draft. A banner names the
  // active track; the track switcher swaps ?draft in the URL.
  const DRAFT_TRACK = (() => {
    const t = new URLSearchParams(location.search).get('draft');
    return t && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(t) ? t : null;
  })();

  // A draft is created by naming it: there is no registry to register with, so
  // the whole "new draft" flow is a validated name plus a URL. The first edit
  // in draft mode autosaves the overlay file into existence.
  function promptNewDraft(known) {
    const seen = (known || []).filter(Boolean);
    const name = window.prompt(
      `Name this draft.${seen.length ? `\n\nAlready here: ${seen.join(', ')}` : ''}` +
      `\n\nShort and lowercase works best — “v2”, “shorter-intro”, “launch”.`, '');
    if (name == null) return;
    const t = name.trim();
    if (!TRACK_RE.test(t)) {
      window.alert(t
        ? `“${t}” won’t work as a draft name — it becomes a folder in the repo.\n\nStart with a letter or number, then letters, numbers, dots, dashes or underscores (64 max).`
        : 'A draft needs a name — try “v2” or “shorter-intro”.');
      return;
    }
    if (t === DRAFT_TRACK) return;      // already looking at it
    const u = new URL(location.href);
    u.searchParams.set('draft', t);
    u.searchParams.set('edit', '1');
    location.href = u.pathname + u.search;
  }

  function draftBanner(tracks, known) {
    if (document.getElementById('plater-draftbar')) return;
    const bar = document.createElement('div');
    bar.id = 'plater-draftbar';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const swap = (t) => {
      const u = new URL(location.href);
      if (t) u.searchParams.set('draft', t); else u.searchParams.delete('draft');
      u.searchParams.set('edit', '1');
      return u.pathname + u.search;
    };
    bar.innerHTML = `<style>
#plater-draftbar{position:fixed;left:0;right:0;bottom:0;z-index:2147483645;display:flex;gap:10px;align-items:center;
  padding:9px 16px;background:#3E2A75;color:#efe9ff;font:600 13px/1 ui-monospace,Menlo,monospace}
#plater-draftbar a{color:#efe9ff;text-decoration:none;border:1px solid rgba(255,255,255,.35);border-radius:5px;padding:4px 10px}
#plater-draftbar a.on{background:#efe9ff;color:#3E2A75}
#plater-draftbar .sp{margin-left:auto;font-weight:400;opacity:.75}
#plater-draftbar .golive{background:#38d996;border:0;color:#0c2c1d;font:700 13px/1 inherit;padding:6px 14px;border-radius:6px;cursor:pointer}
#plater-draftbar .golive:hover{background:#5ff0b0}
#plater-draftbar .golive:disabled{opacity:.5;cursor:default}
#plater-draftbar .autosave{font-weight:400;opacity:.85}
#plater-draftbar .newdraft{background:none;border:1px dashed rgba(255,255,255,.45);color:#efe9ff;
  font:600 13px/1 inherit;padding:4px 10px;border-radius:5px;cursor:pointer}
#plater-draftbar .newdraft:hover{border-style:solid;background:rgba(255,255,255,.12)}
</style>
<span>DRAFTS${DRAFT_TRACK ? ` · “${esc(DRAFT_TRACK)}”` : ''}</span>
<a href="${esc(swap(null))}" class="${DRAFT_TRACK ? '' : 'on'}">live</a>
${tracks.map((t) => `<a href="${esc(swap(t))}" class="${t === DRAFT_TRACK ? 'on' : ''}">${esc(t)}</a>`).join('')}
<button class="newdraft" id="plater-newdraft" type="button" title="Start a fresh draft of this page under a new name — the live page is untouched">+ New draft</button>
${DRAFT_TRACK ? `<span class="autosave" id="plater-autosave">every edit autosaves to this draft</span>
<button class="golive" id="plater-golive" type="button" title="Replace the live page's copy with this draft — one commit, instantly revertable">⬆ Make this live</button>` : `<span class="sp">click a track to see the whole page in that draft — edits autosave, going live is one click</span>`}`;
    document.body.appendChild(bar);

    // Every track known to /api/versions is offerable, not just the ones with a
    // whole-page overlay — the prompt lists them so nobody re-invents a name.
    const nd = document.getElementById('plater-newdraft');
    if (nd) nd.onclick = () => promptNewDraft([...new Set([...(known || []), ...tracks])].sort());

    const golive = document.getElementById('plater-golive');
    if (golive) golive.onclick = async () => {
      if (!ID_TOKEN && !CONFIG.devNoauth) { promptForToken(); if (!ID_TOKEN) return; }
      if (!window.confirm(`Make the “${DRAFT_TRACK}” draft the LIVE copy of this page?\n\nOne commit. The old copy stays in git history; the draft stays editable.`)) return;
      golive.disabled = true; golive.textContent = 'going live…';
      try {
        collectEdits();
        const headers = { 'content-type': 'application/json' };
        if (ID_TOKEN) headers.authorization = 'Bearer ' + ID_TOKEN;
        const r = await fetch(`${apiBase}/save`, { method: 'POST', headers, body: JSON.stringify({ promote: DRAFT_TRACK, content: CONTENT }) });
        const out = await r.json().catch(() => ({}));
        if (!r.ok || out.error) throw new Error(out.error || 'HTTP ' + r.status);
        golive.textContent = 'LIVE ✓';
        setTimeout(() => { location.href = swap(null); }, 900);
      } catch (e) {
        golive.disabled = false; golive.textContent = '⬆ Make this live';
        console.warn('[plater] go-live failed', e);
        setStatus(/conflict/i.test(e.message)
          ? 'Someone else saved the live page just now — reload, then make this draft live again.'
          : 'Could not make this draft live — the live page is unchanged. Try again.');
      }
    };
  }

  /* Draft autosave: in draft mode every edit persists on its own — no Save
     button to remember. Debounced 2s after the last keystroke; the banner
     shows saving…/saved so the state is never a mystery. Rapid consecutive
     saves collapse (git-side each save is one small commit to the overlay). */
  let autosaveTimer = null;
  let autosaveInflight = false;
  function scheduleDraftAutosave() {
    if (!DRAFT_TRACK) return;
    const chip = document.getElementById('plater-autosave');
    if (chip) chip.textContent = 'editing…';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      if (autosaveInflight) { scheduleDraftAutosave(); return; }
      autosaveInflight = true;
      try {
        collectEdits();
        if (JSON.stringify(CONTENT) === SAVED) { if (chip) chip.textContent = 'saved ✓'; return; }
        if (chip) chip.textContent = 'saving…';
        const headers = { 'content-type': 'application/json' };
        if (ID_TOKEN) headers.authorization = 'Bearer ' + ID_TOKEN;
        const r = await fetch(`${apiBase}/save`, { method: 'POST', headers, body: JSON.stringify({ content: CONTENT, track: DRAFT_TRACK }) });
        const out = await r.json().catch(() => ({}));
        // Same race as the manual Save path — merge rather than lose a keystroke.
        if (r.status === 409 && out.error === 'conflict') {
          console.warn('[plater] draft autosave conflict', out.message || '');
          try {
            const n = await mergeAfterConflict();
            if (chip) chip.textContent = 'someone else edited this draft — merged, saving again';
            setStatus(CONFLICT_KEPT(n));
          } catch (mergeErr) {
            console.warn('[plater] conflict merge failed', mergeErr);
            if (chip) chip.textContent = 'draft changed elsewhere — reload';
            setStatus(CONFLICT_LOST_BASE);
          }
          return;
        }
        if (!r.ok || out.error) throw new Error(out.error || 'HTTP ' + r.status);
        SAVED = JSON.stringify(CONTENT);
        clearBuffer();
        if (chip) chip.textContent = 'saved ✓ (draft only)';
      } catch (e) {
        console.warn('[plater] draft autosave failed', e);
        if (chip) chip.textContent = 'autosave failed — will retry on next edit';
      } finally {
        autosaveInflight = false;
      }
    }, 2000);
  }

  async function boot() {
    try {
      const contentUrl = `${apiBase}/content${DRAFT_TRACK ? `?track=${encodeURIComponent(DRAFT_TRACK)}` : ''}`;
      const [cfg, contentRes] = await Promise.all([
        fetch(`${apiBase}/config`).then((r) => r.json()).catch(() => CONFIG),
        fetch(contentUrl),
      ]);
      CONFIG = { ...CONFIG, ...cfg };
      if (DRAFT_TRACK && contentRes.status === 404) {
        // no overlay for this track yet — fall back to live and say so
        CONTENT = await fetch(`${apiBase}/content`).then((r) => r.json());
        setTimeout(() => { const s = $('#cms-status'); if (s) s.textContent = `track "${DRAFT_TRACK}" has no live overlay yet (document draft only — see the ✎ reader)`; }, 400);
      } else {
        CONTENT = await contentRes.json();
      }
    } catch (e) {
      console.error('[zms] content load failed', e);
      return;
    }
    SAVED = JSON.stringify(CONTENT);
    render();

    // draft banner: shows in draft mode always, and on the live page whenever
    // overlay-capable tracks exist (so flipping is one click from ?edit)
    fetchVersionTracks().then(async (tracks) => {
      if (!tracks) { if (DRAFT_TRACK) draftBanner([], []); return; }
      const overlayTracks = [];
      for (const t of Object.keys(tracks)) {
        try { if ((await fetch(`${apiBase}/content?track=${encodeURIComponent(t)}`, { method: 'GET' })).ok) overlayTracks.push(t); } catch {}
      }
      // With no drafts yet the bar is still worth showing to anyone who can
      // edit: "+ New draft" is the only way to start one, and a site whose
      // /api/versions answers is a site where drafts are switched on.
      const canEdit = CONFIG.editable || CONFIG.devNoauth;
      if (DRAFT_TRACK || (canEdit && new URLSearchParams(location.search).has('edit'))) {
        draftBanner(overlayTracks, Object.keys(tracks));
      }
    }).catch(() => { if (DRAFT_TRACK) draftBanner([], []); });

    try { ID_TOKEN = ID_TOKEN || localStorage.getItem(tokenKey); } catch {}
    setLoggedIn(Boolean(ID_TOKEN));

    // edit mode is opt-in: ?edit  OR  Cmd/Ctrl+E  OR  the toolbar button
    const wantEdit = new URLSearchParams(location.search).has('edit');
    const enableEditUI = () => {
      const bar = $('#cms-bar'); if (bar) bar.hidden = false;
      mountHistoryButton();
      initSitemap().then(positionSitemap).catch(() => {});
      if (CONFIG.googleClientId) { if ($('#cms-signin')) $('#cms-signin').hidden = false; initSignIn(); }
      else if (CONFIG.tokenAuth) { promptForToken(); }
      else if (CONFIG.devNoauth) { setLoggedIn(true); if ($('#cms-edit')) $('#cms-edit').hidden = false; if ($('#cms-status')) $('#cms-status').textContent = 'dev mode — no auth (localhost)'; }
      else {
        // Nothing can authenticate here. Hide the sign-in that would do nothing
        // and hand over the checklist that finishes the install instead.
        if ($('#cms-signin')) $('#cms-signin').hidden = true;
        if ($('#cms-edit')) $('#cms-edit').hidden = true;
        if ($('#cms-status')) $('#cms-status').textContent = 'not set up yet — the checklist is one step from done';
        setupPanel();
      }
    };
    if (wantEdit || DRAFT_TRACK) enableEditUI();
    // in draft mode go straight into editing once a credential exists —
    // viewing a draft IS editing it (that's the point of flipping to one)
    if (DRAFT_TRACK && (ID_TOKEN || CONFIG.devNoauth)) setEditable(true);
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
    // Exposed so @platercms/capture can authenticate note-routing with the same
    // credential the editor uses (Google ID token or shared edit token).
    getToken: () => ID_TOKEN,
    getConfig: () => CONFIG,
  };
}

export const initPlater = initZMS;
export default initZMS;
