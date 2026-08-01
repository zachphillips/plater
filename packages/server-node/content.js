// GET /api/content — serves the site's content JSON from disk.
// Path is configurable via GITHUB_EDIT_PATH (default web/content/site.json),
// so the same handler serves any site's content file.
//
// ?track=<name> serves the DRAFT OVERLAY for a versions track instead:
// web/content/versions/<track>/site.json — the whole content object in that
// track's voice, deep-merged over the live content so unmigrated keys still
// render. This is what makes drafts flippable LIVE in the page: the editor
// binds the overlay into the same data-bind slots the real copy uses.
//
// ?file=<rel> serves an ALTERNATE content JSON — a multi-file site keeps
// pricing.json, about.json etc. beside site.json and each page asks for its
// own. The path is resolved and required to sit inside the content directory
// (dirname of GITHUB_EDIT_PATH) and to end in .json, so `../../.env`,
// `..%2f` decoded traversal, and absolute paths all get a 400, never a read.
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// The one root every ?file= read must resolve under.
const CONTENT_DIR = path.resolve(process.cwd(), path.dirname(CONTENT_PATH));

// True when `abs` is the content dir or sits beneath it. The separator guard
// keeps a sibling `content-secrets/` from matching the `content` prefix.
function inside(abs, root) {
  return abs === root || abs.startsWith(root + path.sep);
}

// Returns the absolute path, or null if the request escapes the content dir.
function resolveFile(rel) {
  if (!rel || rel.length > 255 || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  if (!rel.toLowerCase().endsWith('.json')) return null;
  const abs = path.resolve(CONTENT_DIR, rel);
  // Prefix check on the RESOLVED path — this is what stops ../ traversal.
  return inside(abs, CONTENT_DIR) ? abs : null;
}

// Lexical resolution is not enough on its own: a symlink committed inside the
// content dir could point at /etc or at the repo's .env. Compare real paths
// (both sides resolved, so a symlinked repo root still matches itself).
async function realInside(abs) {
  try {
    const [realFile, realRoot] = await Promise.all([fs.realpath(abs), fs.realpath(CONTENT_DIR)]);
    return inside(realFile, realRoot) ? realFile : null;
  } catch {
    return null; // missing file (or dangling link) — caller reports 404
  }
}

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...(typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // Default file is the configured one; ?file=<rel> picks another JSON in the
  // same content directory. `file` is the name relative to that directory.
  const wanted = String(req.query?.file || '');
  let basePath = path.resolve(process.cwd(), CONTENT_PATH);
  let name = path.basename(CONTENT_PATH);
  if (wanted) {
    const abs = resolveFile(wanted);
    if (!abs) return res.status(400).json({ error: 'bad file' });
    name = path.relative(CONTENT_DIR, abs);
    // An alternate file that does not exist is a 404, not a silent empty object —
    // otherwise a typo'd ?file= renders a blank page that looks like lost content.
    const real = await realInside(abs);
    if (!real) {
      const stat = await fs.lstat(abs).then(() => true, () => false);
      // Exists but resolves outside → same 400 as lexical traversal, no oracle
      // about what the link points at.
      return stat ? res.status(400).json({ error: 'bad file' }) : res.status(404).json({ error: `no content file "${name}"` });
    }
    if (!(await fs.stat(real).then((s) => s.isFile(), () => false))) {
      return res.status(404).json({ error: `no content file "${name}"` });
    }
    basePath = real;
  }

  const base = await fs.readFile(basePath, 'utf8').catch(() => '{}');
  const track = String(req.query?.track || '');
  if (!track) return res.status(200).send(base);
  if (!TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name' });
  // Track overlays mirror the content dir, so an alternate file's overlay lives
  // at versions/<track>/<same relative name>.
  const overlayPath = path.join(CONTENT_DIR, 'versions', track, name);
  try {
    const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf8'));
    return res.status(200).send(JSON.stringify(deepMerge(JSON.parse(base), overlay)));
  } catch {
    // no overlay for this track → 404 so the editor can say "this track has
    // no live-flippable content yet (document draft only)"
    return res.status(404).json({ error: `track "${track}" has no site.json overlay` });
  }
}
