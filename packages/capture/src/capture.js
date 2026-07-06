// @plater/capture — click an element on the live page, leave a note, choose where
// it goes (engine × output), and route it to the agent host via the site's
// /api/agent-note relay. A refined, unobtrusive editing overlay: it sits on top
// of the host site, imposes no fonts, and stays out of the way until invoked.
//
// initCapture({ apiBase, getToken, engines, outputs, defaults, brand })
//   -> { enter, exit, toggle, openFor }

const NS = 'zmscap';
const clamp = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function injectStyles() {
  if (document.getElementById(`${NS}-style`)) return;
  const css = `
  .${NS}-hl{position:fixed;pointer-events:none;z-index:2147483640;border:2px solid #c9a96e;
    border-radius:3px;background:rgba(201,169,110,.10);transition:all .06s ease;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
  .${NS}-hl-tag{position:absolute;top:-22px;left:-2px;background:#c9a96e;color:#111;font:600 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:0 6px;border-radius:3px;white-space:nowrap;letter-spacing:.02em}
  body.${NS}-picking, body.${NS}-picking *{cursor:crosshair !important}
  .${NS}-pop{position:fixed;z-index:2147483641;width:340px;max-width:calc(100vw - 24px);
    background:#141414;color:#e8e3d9;border:1px solid #2f2b25;border-radius:10px;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.7),0 0 0 1px rgba(201,169,110,.12);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden;animation:${NS}in .12s ease}
  @keyframes ${NS}in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  .${NS}-pop header{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid #232019;background:#191712}
  .${NS}-dot{width:7px;height:7px;border-radius:50%;background:#c9a96e;box-shadow:0 0 8px #c9a96e}
  .${NS}-pop header b{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9a96e}
  .${NS}-x{margin-left:auto;background:none;border:0;color:#7a736a;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}
  .${NS}-x:hover{color:#e8e3d9}
  .${NS}-body{padding:12px 13px;display:flex;flex-direction:column;gap:11px}
  .${NS}-target{display:flex;gap:7px;align-items:center;font:600 11px/1.4 ui-monospace,Menlo,monospace;color:#8a8277}
  .${NS}-chip{background:#221f18;border:1px solid #332f26;color:#c9a96e;padding:2px 7px;border-radius:4px;max-width:100%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .${NS}-ta{width:100%;min-height:74px;resize:vertical;background:#0f0e0b;border:1px solid #2f2b25;border-radius:7px;
    color:#e8e3d9;padding:9px 10px;font:14px/1.45 inherit;outline:none}
  .${NS}-ta:focus{border-color:#c9a96e;box-shadow:0 0 0 3px rgba(201,169,110,.12)}
  .${NS}-ta::placeholder{color:#5a554d}
  .${NS}-row{display:flex;flex-direction:column;gap:5px}
  .${NS}-lab{font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:#6d665c}
  .${NS}-seg{display:flex;gap:4px}
  .${NS}-seg button{flex:1;background:#1b1813;border:1px solid #2f2b25;color:#b8b0a4;padding:6px 4px;border-radius:6px;
    font:600 12px/1 inherit;cursor:pointer;transition:all .1s}
  .${NS}-seg button:hover{border-color:#4a4438;color:#e8e3d9}
  .${NS}-seg button[aria-pressed="true"]{background:#c9a96e;border-color:#c9a96e;color:#151208}
  .${NS}-foot{display:flex;gap:8px;align-items:center;padding:11px 13px;border-top:1px solid #232019;background:#111}
  .${NS}-status{font-size:12px;color:#8a8277;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .${NS}-status a{color:#9fb8d8}
  .${NS}-send{background:#c9a96e;border:0;color:#151208;font:700 13px/1 inherit;padding:8px 14px;border-radius:7px;cursor:pointer}
  .${NS}-send:hover{background:#d8bd86}
  .${NS}-send:disabled{opacity:.5;cursor:default}
  .${NS}-launch{background:#1b1813;border:1px solid #3a352b;color:#c9a96e;font:600 12px/1 inherit;padding:5px 9px;
    border-radius:5px;cursor:pointer}
  .${NS}-launch[aria-pressed="true"]{background:#c9a96e;color:#151208;border-color:#c9a96e}
  `;
  const s = document.createElement('style'); s.id = `${NS}-style`; s.textContent = css;
  document.head.appendChild(s);
}

function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return '#' + (window.CSS?.escape ? CSS.escape(el.id) : el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    let sel = node.nodeName.toLowerCase();
    if (node.dataset && node.dataset.bind) { parts.unshift(`${sel}[data-bind="${node.dataset.bind}"]`); break; }
    const parent = node.parentNode;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.nodeName === node.nodeName);
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(sel);
    node = node.parentNode;
  }
  return parts.join(' > ');
}

function contentPathFor(el) {
  const p = el.closest('[data-path]'); if (p) return p.dataset.path;
  const b = el.closest('[data-bind]'); if (b) return b.dataset.bind;
  return '';
}

function captureFor(el) {
  const r = el.getBoundingClientRect();
  return {
    selector: cssPath(el),
    contentPath: contentPathFor(el),
    tag: el.nodeName.toLowerCase(),
    text: clamp(el.textContent, 300),
    outerHTML: clamp(el.outerHTML, 2000),
    url: location.href,
    rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
  };
}

export function initCapture(opts = {}) {
  const {
    apiBase = '/api',
    getToken = () => null,
    engines = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }, { id: 'local', label: 'Local' }],
    outputs = [{ id: 'pr', label: 'Open PR' }, { id: 'push', label: 'Publish' }],
    defaults = { engine: 'claude', output: 'pr' },
    brand = 'Plater',
    barSelector = '#cms-bar',
  } = opts;

  injectStyles();

  const hl = document.createElement('div'); hl.className = `${NS}-hl`; hl.style.display = 'none';
  hl.innerHTML = `<span class="${NS}-hl-tag"></span>`;
  document.body.appendChild(hl);

  let picking = false, pop = null, current = null;
  const route = { engine: defaults.engine, output: defaults.output };

  const isTool = (el) => el && (el.closest(`.${NS}-pop`) || el.closest(`.${NS}-hl`) || el.closest(barSelector) || el.closest(`.${NS}-launch`));

  function moveHL(el) {
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
    hl.querySelector(`.${NS}-hl-tag`).textContent = el.dataset?.bind || el.nodeName.toLowerCase();
  }

  function onMove(e) {
    if (!picking) return;
    const el = e.target;
    if (isTool(el)) { hl.style.display = 'none'; return; }
    moveHL(el);
  }
  function onClick(e) {
    if (!picking) return;
    if (isTool(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    openFor(e.target);
    exit();
  }
  function onKey(e) { if (e.key === 'Escape') { closePop(); exit(); } }

  function enter() {
    if (picking) return;
    picking = true;
    document.body.classList.add(`${NS}-picking`);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    if (launcher) launcher.setAttribute('aria-pressed', 'true');
  }
  function exit() {
    picking = false;
    document.body.classList.remove(`${NS}-picking`);
    hl.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    if (launcher) launcher.setAttribute('aria-pressed', 'false');
  }
  function toggle() { picking ? exit() : enter(); }

  function closePop() { if (pop) { pop.remove(); pop = null; current = null; } }

  function seg(kind, items) {
    return `<div class="${NS}-row"><span class="${NS}-lab">${kind === 'engine' ? 'Send to' : 'Then'}</span>` +
      `<div class="${NS}-seg" data-seg="${kind}">` +
      items.map((it) => `<button type="button" data-val="${it.id}" aria-pressed="${route[kind] === it.id}">${it.label}</button>`).join('') +
      `</div></div>`;
  }

  function openFor(el) {
    closePop();
    current = captureFor(el);
    pop = document.createElement('div');
    pop.className = `${NS}-pop`;
    pop.innerHTML =
      `<header><span class="${NS}-dot"></span><b>Note to agent</b><button class="${NS}-x" title="Close">✕</button></header>` +
      `<div class="${NS}-body">` +
        `<div class="${NS}-target">on <span class="${NS}-chip">${current.contentPath ? current.contentPath : current.selector || current.tag}</span></div>` +
        `<textarea class="${NS}-ta" placeholder="Describe the change… e.g. “make this headline bigger and warmer”"></textarea>` +
        seg('engine', engines) +
        seg('output', outputs) +
      `</div>` +
      `<div class="${NS}-foot"><span class="${NS}-status">${current.contentPath ? 'bound content' : 'element'} selected</span>` +
        `<button class="${NS}-send" type="button">Send →</button></div>`;
    document.body.appendChild(pop);

    // position near the element, clamped to viewport
    const r = current.rect; const pw = 340, ph = pop.offsetHeight || 300;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.top + r.height + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';

    const ta = pop.querySelector(`.${NS}-ta`);
    setTimeout(() => ta.focus(), 20);
    pop.querySelector(`.${NS}-x`).onclick = closePop;
    pop.querySelectorAll(`.${NS}-seg`).forEach((grp) => {
      const kind = grp.dataset.seg;
      grp.querySelectorAll('button').forEach((b) => b.onclick = () => {
        route[kind] = b.dataset.val;
        grp.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      });
    });
    const status = pop.querySelector(`.${NS}-status`);
    const send = pop.querySelector(`.${NS}-send`);
    send.onclick = async () => {
      const note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      send.disabled = true; status.textContent = 'sending…';
      try {
        const token = getToken && getToken();
        const headers = { 'content-type': 'application/json' };
        if (token) headers.authorization = 'Bearer ' + token;
        const res = await fetch(`${apiBase}/agent-note`, { method: 'POST', headers, body: JSON.stringify({ note, capture: current, route }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) { status.textContent = 'failed: ' + (out.error || res.status); send.disabled = false; return; }
        status.innerHTML = out.prUrl ? `sent → <a href="${out.prUrl}" target="_blank">PR</a>` : `queued · ${out.id || 'ok'} (${route.engine} · ${route.output})`;
        send.textContent = 'Sent ✓';
      } catch (e) { status.textContent = 'error: ' + e.message; send.disabled = false; }
    };
    return pop;
  }

  // launcher button — prefer the CMS bar, else float bottom-right
  let launcher = document.createElement('button');
  launcher.className = `${NS}-launch`; launcher.type = 'button'; launcher.setAttribute('aria-pressed', 'false');
  launcher.textContent = '✎ Note';
  launcher.title = 'Leave a note on any element for an agent';
  launcher.onclick = toggle;
  const bar = document.querySelector(barSelector);
  if (bar) {
    const status = bar.querySelector('#cms-status');
    bar.insertBefore(launcher, status || null);
  } else {
    Object.assign(launcher.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483639, padding: '9px 13px' });
    document.body.appendChild(launcher);
  }

  window.addEventListener('scroll', () => { if (picking) hl.style.display = 'none'; }, true);
  return { enter, exit, toggle, openFor };
}

export default initCapture;
