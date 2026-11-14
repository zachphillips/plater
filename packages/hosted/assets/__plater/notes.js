// Hosted Plater page chrome: the ✎ Note overlay (notes run on the owner's
// ChatGPT plan through the note runner) and a version pill linking to the
// project's history. Older versions say so and link to the latest.
import { initCapture } from '/packages/capture/src/capture.js';

const me = document.querySelector('script[src="/__plater/notes.js"]');
const project = me?.dataset.project || '';
const n = Number(me?.dataset.version || 0), head = Number(me?.dataset.head || 0);
const atHead = n === head;

const PILL = { position: 'fixed', bottom: '16px', zIndex: 2147483639, padding: '7px 11px', borderRadius: '6px',
  font: '600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace', textDecoration: 'none', letterSpacing: '.02em' };

function link(href, label, aria, style) {
  const a = document.createElement('a');
  a.href = href; a.textContent = label; a.setAttribute('aria-label', aria);
  Object.assign(a.style, PILL, style);
  document.body.appendChild(a);
}

function pill() {
  link(`/${project}/review`, atHead ? `v${n} · history` : `v${n} of ${head} · read-only · history`,
    atHead ? `Version ${n}. Open the project history.` : `Version ${n} of ${head}, read-only. Open the project history.`,
    { left: '16px', background: '#1b1813', border: '1px solid #3a352b', color: '#c9a96e' });
  if (!atHead) link(`/${project}/`, 'open latest →', 'Open the latest version', { right: '16px', background: '#c9a96e', border: '1px solid #c9a96e', color: '#151208' });
}

const start = () => {
  pill();
  if (!atHead || document.querySelector('.zmscap-launch')) return;
  initCapture({ apiBase: '/api', brand: 'Plater',
    engines: [{ id: 'chatgpt', label: 'ChatGPT' }], outputs: [{ id: 'version', label: 'New version' }],
    defaults: { engine: 'chatgpt', output: 'version' } });
};
const wait = (k) => (document.getElementById('cms-bar') || k <= 0) ? start() : setTimeout(() => wait(k - 1), 100);
document.readyState === 'loading' ? addEventListener('DOMContentLoaded', () => wait(15)) : wait(15);
