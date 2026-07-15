// GET /api/content — serves the site's content JSON from disk.
// Path is configurable via GITHUB_EDIT_PATH (default web/content/site.json),
// so the same handler serves any site's content file.
//
// ?track=<name> serves the DRAFT OVERLAY for a versions track instead:
// web/content/versions/<track>/site.json — the whole content object in that
// track's voice, deep-merged over the live content so unmigrated keys still
// render. This is what makes drafts flippable LIVE in the page: the editor
// binds the overlay into the same data-bind slots the real copy uses.
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';
const TRACK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

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
  const base = await fs.readFile(path.join(process.cwd(), CONTENT_PATH), 'utf8').catch(() => '{}');
  const track = String(req.query?.track || '');
  if (!track) return res.status(200).send(base);
  if (!TRACK_RE.test(track)) return res.status(400).json({ error: 'bad track name' });
  const overlayPath = path.join(process.cwd(), path.dirname(CONTENT_PATH), 'versions', track, 'site.json');
  try {
    const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf8'));
    return res.status(200).send(JSON.stringify(deepMerge(JSON.parse(base), overlay)));
  } catch {
    // no overlay for this track → 404 so the editor can say "this track has
    // no live-flippable content yet (document draft only)"
    return res.status(404).json({ error: `track "${track}" has no site.json overlay` });
  }
}
