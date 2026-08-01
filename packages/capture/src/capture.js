// @platercms/capture — click an element on the live page, leave a note, choose where
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
  .${NS}-mode{margin-left:auto;background:#1b1813;border:1px solid #3a352b;color:#c9a96e;font:600 11px/1 ui-monospace,Menlo,monospace;
    padding:4px 8px;border-radius:5px;cursor:pointer;letter-spacing:.04em}
  .${NS}-mode[aria-pressed="true"]{background:#c9a96e;color:#151208;border-color:#c9a96e}
  .${NS}-mode+.${NS}-x{margin-left:0}
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
  .${NS}-badge{margin-left:5px;font:700 10px/1 ui-monospace,Menlo,monospace;opacity:.75}
  .${NS}-tray{position:fixed;right:12px;z-index:2147483642;width:352px;max-width:calc(100vw - 24px);
    max-height:min(66vh,560px);display:flex;flex-direction:column;background:#141414;color:#e8e3d9;
    border:1px solid #2f2b25;border-radius:10px;overflow:hidden;
    box-shadow:0 18px 50px -12px rgba(0,0,0,.7),0 0 0 1px rgba(201,169,110,.12);
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;animation:${NS}in .12s ease}
  .${NS}-tray header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #232019;background:#191712}
  .${NS}-tray header b{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#c9a96e}
  .${NS}-tray header .n{font:600 11px/1 ui-monospace,Menlo,monospace;color:#6d665c}
  .${NS}-clear{margin-left:auto;background:none;border:1px solid #2f2b25;color:#8a8277;font:600 10px/1.6 ui-monospace,Menlo,monospace;
    letter-spacing:.06em;text-transform:uppercase;padding:1px 7px;border-radius:5px;cursor:pointer}
  .${NS}-clear:hover{border-color:#a5453a;color:#e8b3ac}
  .${NS}-clear+.${NS}-x{margin-left:0}
  .${NS}-clear[hidden]{display:none}
  .${NS}-list{overflow-y:auto;padding:6px 0;-webkit-overflow-scrolling:touch}
  .${NS}-note{display:flex;flex-direction:column;gap:4px;padding:9px 12px;border-bottom:1px solid #1d1a15;position:relative}
  .${NS}-note:last-child{border-bottom:0}
  .${NS}-note .t{color:#ddd6c9;padding-right:18px;overflow-wrap:anywhere}
  .${NS}-note .m{display:flex;flex-wrap:wrap;gap:6px;align-items:center;
    font:600 10px/1.5 ui-monospace,Menlo,monospace;color:#6d665c}
  .${NS}-note .m .st{color:#c9a96e}
  .${NS}-note .m .st.err{color:#d08a80}
  .${NS}-note .m .st.done{color:#7fae7f}
  .${NS}-note .m a{color:#9fb8d8}
  .${NS}-note .rm{position:absolute;top:6px;right:7px;background:none;border:0;color:#4d4842;font-size:14px;line-height:1;
    padding:2px 4px;cursor:pointer}
  .${NS}-note .rm:hover{color:#d08a80}
  .${NS}-empty{padding:22px 16px;text-align:center;color:#6d665c;font-size:12px}
  .${NS}-empty b{display:block;color:#8a8277;font:600 11px/1.8 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
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

/* ---------------- note log ---------------- */
// Notes used to vanish the moment the popover closed: you sent one, got a job
// id in a status line, and had no way to answer "did that land?". The log is
// deliberately local-only (localStorage, this browser) — it is a receipt book,
// not state the server owes anyone. Reads and writes are total: a corrupt or
// quota-full store degrades to "no notes", never to a thrown error mid-send.
const NOTES_KEY = 'plater-notes';
const NOTES_MAX = 200;

function readNotes() {
  try {
    const arr = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((n) => n && typeof n === 'object' && n.id) : [];
  } catch { return []; }
}
function writeNotes(list) {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(list.slice(0, NOTES_MAX))); } catch {}
  return list;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only http(s) links are ever rendered as links — a note's status payload comes
// back from the agent host, so javascript:/data: must not become clickable.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');

// Job ids are hex on the agent host; the dev echo answers "dev-echo", which is
// not pollable. Anything non-hex is treated as un-pollable rather than sent.
const pollable = (job) => /^[a-f0-9]+$/i.test(String(job || ''));

const DONE_RE = /^(done|complete|completed|merged|pushed|shipped|alternatives-ready)$/i;
const FAIL_RE = /^(error|failed|cancelled|canceled|timeout)$/i;

const noteAge = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

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

  // One JSON call to the relay, shared by the popover and the tray's poller.
  const apiPost = async (payload) => {
    const token = getToken && getToken();
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch(`${apiBase}/agent-note`, { method: 'POST', headers, body: JSON.stringify(payload) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) throw new Error(out.error || 'HTTP ' + res.status);
    return out;
  };

  // Tool chrome is never a note target — picking inside the tray would capture
  // the tray itself instead of the page element the user meant.
  const isTool = (el) => el && (el.closest(`.${NS}-pop`) || el.closest(`.${NS}-hl`) || el.closest(barSelector)
    || el.closest(`.${NS}-launch`) || el.closest(`.${NS}-tray`));

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
    let mode = 'note'; // 'note' → code change; 'design' → image alternatives first
    pop = document.createElement('div');
    pop.className = `${NS}-pop`;
    pop.innerHTML =
      `<header><span class="${NS}-dot"></span><b>Note to agent</b>` +
        `<button class="${NS}-mode" type="button" title="Design mode: generate visual alternatives to choose from BEFORE any code is written" aria-pressed="false">✦ Design</button>` +
        `<button class="${NS}-x" title="Close">✕</button></header>` +
      `<div class="${NS}-body">` +
        `<div class="${NS}-target">on <span class="${NS}-chip">${current.contentPath ? current.contentPath : current.selector || current.tag}</span></div>` +
        `<textarea class="${NS}-ta" placeholder="Describe the change… e.g. “make this headline bigger and warmer”"></textarea>` +
        `<div class="${NS}-alts" style="display:none"></div>` +
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
    const altsEl = pop.querySelector(`.${NS}-alts`);
    const modeBtn = pop.querySelector(`.${NS}-mode`);
    modeBtn.onclick = () => {
      mode = mode === 'note' ? 'design' : 'note';
      modeBtn.setAttribute('aria-pressed', mode === 'design');
      send.textContent = mode === 'design' ? 'Generate 3 looks →' : 'Send →';
      ta.placeholder = mode === 'design'
        ? 'Describe the direction… e.g. “warmer, more editorial, less tech”'
        : 'Describe the change… e.g. “make this headline bigger and warmer”';
      status.textContent = mode === 'design'
        ? 'design mode — images first, code only after you pick one'
        : `${current.contentPath ? 'bound content' : 'element'} selected`;
    };

    const api = apiPost;

    const imgSrc = async (jobId, n) => {
      // fetch through the same-origin relay so the agent-host bearer stays server-side
      const token = getToken && getToken();
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      const r = await fetch(`${apiBase}/agent-note`, { method: 'POST', headers, body: JSON.stringify({ action: 'image', job: jobId, n }) });
      if (!r.ok) throw new Error('image fetch failed');
      return URL.createObjectURL(await r.blob());
    };

    async function pollDesign(jobId, note) {
      for (let i = 0; i < 150; i++) { // up to ~12.5 min
        await new Promise((r) => setTimeout(r, 5000));
        const st = await api({ action: 'status', job: jobId });
        if (st.status === 'error') throw new Error(st.detail || 'design job failed');
        if (st.status === 'alternatives-ready') return st.alternatives || [];
        status.textContent = `designing… (${st.status})`;
      }
      throw new Error('design job timed out');
    }

    async function showAlternatives(jobId, note) {
      const alternatives = await pollDesign(jobId, note);
      altsEl.style.display = 'flex';
      Object.assign(altsEl.style, { flexDirection: 'column', gap: '8px' });
      altsEl.innerHTML = `<span class="${NS}-lab">Pick a direction — or refine the note and generate more</span>`;
      for (const ref of alternatives) {
        const n = Number((ref.match(/alt-(\d+)\.png$/) || [])[1]);
        const card = document.createElement('div');
        Object.assign(card.style, { border: '1px solid #2f2b25', borderRadius: '7px', overflow: 'hidden', cursor: 'pointer' });
        const img = document.createElement('img');
        Object.assign(img.style, { width: '100%', display: 'block' });
        img.alt = `design alternative ${n}`;
        img.src = await imgSrc(jobId, n);
        const bar = document.createElement('div');
        Object.assign(bar.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 9px', background: '#191712' });
        bar.innerHTML = `<span style="font:600 11px ui-monospace,monospace;color:#8a8277">concept ${n}</span>`;
        const use = document.createElement('button');
        use.textContent = 'Build this ✓';
        Object.assign(use.style, { background: '#c9a96e', border: '0', color: '#151208', font: '700 12px inherit', padding: '5px 10px', borderRadius: '5px', cursor: 'pointer' });
        use.onclick = async (e) => {
          e.stopPropagation();
          use.disabled = true; status.textContent = 'sending the chosen design to the build agent…';
          try {
            const out = await api({ action: 'accept', designJob: jobId, alternative: n, note, route });
            logNote(`${note} — building concept ${n}`, out, route.output);
            status.textContent = `building from concept ${n} · job ${out.id} → PR when done`;
            send.textContent = 'Accepted ✓';
          } catch (err) { status.textContent = 'accept failed: ' + err.message; use.disabled = false; }
        };
        bar.appendChild(use);
        card.appendChild(img); card.appendChild(bar);
        altsEl.appendChild(card);
      }
      // wider popover while comparing designs
      pop.style.width = '460px';
      status.textContent = `${alternatives.length} directions ready — click one to build it, or refine the note and generate more`;
    }

    send.onclick = async () => {
      const note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      send.disabled = true;
      // The receipt is written from the RESPONSE, not optimistically: a note the
      // relay refused never happened, and logging it would be a lie in the tray.
      try {
        if (mode === 'design') {
          status.textContent = 'screenshotting the live page…';
          const out = await api({ action: 'design', note, capture: current });
          logNote(note, out, 'design');
          await showAlternatives(out.id, note);
          send.disabled = false; send.textContent = 'Generate more →';
        } else {
          status.textContent = 'sending…';
          const out = await api({ note, capture: current, route });
          logNote(note, out, route.output);
          const url = safeUrl(out.prUrl);
          status.innerHTML = url ? `sent → <a href="${esc(url)}" target="_blank" rel="noopener">PR</a>`
            : `queued · ${esc(out.id || 'ok')} (${esc(route.engine)} · ${esc(route.output)})`;
          send.textContent = 'Sent ✓';
        }
      } catch (e) { status.textContent = 'error: ' + e.message; send.disabled = false; }
    };

    // The note this popover records: bindPath is the CONTENT path when the
    // click landed on bound copy, else the CSS selector — the two things that
    // let a later reader find the element the note is about.
    function logNote(text, out, output) {
      const job = pollable(out && out.id) ? String(out.id) : undefined;
      const rec = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        text,
        bindPath: (current && (current.contentPath || current.selector)) || '',
        engine: route.engine,
        output,
        // dev echo answers 202 with a non-hex id and a `dev` note; there is no
        // job to poll, so it is terminal on arrival and says so.
        status: out && out.dev ? 'sent — dev echo' : (out && out.status) || 'queued',
        ...(job ? { job } : {}),
        ...(safeUrl(out && out.prUrl) ? { prUrl: safeUrl(out.prUrl) } : {}),
      };
      writeNotes([rec, ...readNotes()]);
      renderTray();
    }
    return pop;
  }

  /* ---------------- notes tray ---------------- */
  // A pane, not a modal: no overlay, no focus trap, nothing that stops the page
  // being read or edited while it is open. It answers one question — what did I
  // send, and where did it get to. Polling only runs while it is open, so a
  // forgotten tab costs nothing.

  let trayEl = null;
  let pollTimer = null;

  function notesCount() { return readNotes().length; }

  function updateBadge() {
    if (!badge) return;
    const n = notesCount();
    badge.textContent = n ? String(n) : '';
    notesBtn.title = n ? `${n} note${n === 1 ? '' : 's'} sent from this browser` : 'Notes you send are logged here';
  }

  function noteHtml(n) {
    const cls = FAIL_RE.test(n.status) ? ' err' : DONE_RE.test(n.status) || /dev echo/.test(n.status) ? ' done' : '';
    const url = safeUrl(n.prUrl);
    return `<div class="${NS}-note" data-note="${esc(n.id)}">` +
      `<button class="rm" type="button" title="Dismiss this note" data-dismiss="${esc(n.id)}">✕</button>` +
      `<div class="t">${esc(n.text)}</div>` +
      `<div class="m"><span class="st${cls}">${esc(n.status || 'queued')}</span>` +
      `<span>${esc(noteAge(Number(n.ts) || Date.now()))}</span>` +
      (n.bindPath ? `<span>${esc(n.bindPath)}</span>` : '') +
      `<span>${esc(n.engine || '')}${n.output ? ' · ' + esc(n.output) : ''}</span>` +
      (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">open PR ↗</a>` : '') +
      `</div></div>`;
  }

  function renderTray() {
    updateBadge();
    if (!trayEl) return;
    const notes = readNotes();
    trayEl.querySelector(`.${NS}-list`).innerHTML = notes.length
      ? notes.map(noteHtml).join('')
      : `<div class="${NS}-empty"><b>No notes yet</b>Click <strong>✎ Note</strong>, pick anything on the page, ` +
        `and say what should change. Every note you send shows up here with its status.</div>`;
    trayEl.querySelector('.n').textContent = notes.length ? `${notes.length}` : '';
    trayEl.querySelector(`.${NS}-clear`).hidden = !notes.length;
    trayEl.querySelectorAll('[data-dismiss]').forEach((b) => {
      b.onclick = () => { writeNotes(readNotes().filter((x) => x.id !== b.dataset.dismiss)); renderTray(); };
    });
  }

  // One status sweep. Each job is polled independently so one dead job cannot
  // stall the rest, and a failed poll leaves the last known status alone rather
  // than reporting a network blip as a job failure.
  async function pollNotes() {
    const live = readNotes().filter((n) => n.job && pollable(n.job) && !DONE_RE.test(n.status) && !FAIL_RE.test(n.status));
    if (!live.length) return;
    const results = await Promise.all(live.map(async (n) => {
      try { return [n.id, await apiPost({ action: 'status', job: n.job })]; } catch { return null; }
    }));
    let changed = false;
    const byId = new Map(results.filter(Boolean));
    const next = readNotes().map((n) => {
      const st = byId.get(n.id);
      if (!st) return n;
      const status = st.status || n.status;
      const prUrl = safeUrl(st.prUrl || st.url || (st.result && (st.result.prUrl || st.result.url))) || n.prUrl;
      if (status === n.status && prUrl === n.prUrl) return n;
      changed = true;
      return { ...n, status, ...(prUrl ? { prUrl } : {}) };
    });
    if (changed) { writeNotes(next); renderTray(); }
  }

  function openTray() {
    if (trayEl) return;
    trayEl = document.createElement('div');
    trayEl.className = `${NS}-tray`;
    trayEl.setAttribute('role', 'region');
    trayEl.setAttribute('aria-label', 'Notes sent to agents');
    trayEl.innerHTML = `<header><span class="${NS}-dot"></span><b>Notes</b><span class="n"></span>` +
      `<button class="${NS}-clear" type="button" title="Remove every note from this list">Clear all</button>` +
      `<button class="${NS}-x" type="button" title="Close">✕</button></header><div class="${NS}-list"></div>`;
    document.body.appendChild(trayEl);
    positionTray();
    trayEl.querySelector(`.${NS}-x`).onclick = closeTray;
    trayEl.querySelector(`.${NS}-clear`).onclick = () => {
      if (!notesCount() || !window.confirm('Clear every note from this list? The agent jobs themselves are unaffected.')) return;
      writeNotes([]); renderTray();
    };
    renderTray();
    notesBtn.setAttribute('aria-pressed', 'true');
    pollNotes().catch(() => {});
    pollTimer = setInterval(() => { pollNotes().catch(() => {}); }, 10000);
  }

  function closeTray() {
    clearInterval(pollTimer); pollTimer = null;
    if (trayEl) { trayEl.remove(); trayEl = null; }
    notesBtn.setAttribute('aria-pressed', 'false');
  }

  // Sits under the bar when there is one (top or bottom), else near the launcher.
  function positionTray() {
    if (!trayEl) return;
    const b = document.querySelector(barSelector);
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (b && !b.hidden) {
      const r = b.getBoundingClientRect();
      if (r.top > vh / 2) { trayEl.style.bottom = Math.max(8, Math.round(vh - r.top + 8)) + 'px'; trayEl.style.top = 'auto'; }
      else { trayEl.style.top = Math.max(8, Math.round(r.bottom + 8)) + 'px'; trayEl.style.bottom = 'auto'; }
    } else { trayEl.style.bottom = '64px'; trayEl.style.top = 'auto'; }
  }
  window.addEventListener('resize', positionTray);

  const notesBtn = document.createElement('button');
  notesBtn.className = `${NS}-launch`; notesBtn.type = 'button';
  notesBtn.setAttribute('aria-pressed', 'false');
  notesBtn.innerHTML = `Notes<span class="${NS}-badge"></span>`;
  const badge = notesBtn.querySelector(`.${NS}-badge`);
  notesBtn.onclick = () => (trayEl ? closeTray() : openTray());

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
    bar.insertBefore(notesBtn, status || null);
  } else {
    Object.assign(launcher.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483639, padding: '9px 13px' });
    Object.assign(notesBtn.style, { position: 'fixed', right: '104px', bottom: '16px', zIndex: 2147483639, padding: '9px 13px' });
    document.body.appendChild(launcher);
    document.body.appendChild(notesBtn);
  }
  updateBadge();

  window.addEventListener('scroll', () => { if (picking) hl.style.display = 'none'; }, true);
  return { enter, exit, toggle, openFor, openNotes: openTray, closeNotes: closeTray };
}

export default initCapture;
