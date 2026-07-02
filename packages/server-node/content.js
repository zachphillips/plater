// GET /api/content — serves the site's content JSON from disk.
// Path is configurable via GITHUB_EDIT_PATH (default web/content/site.json),
// so the same handler serves any site's content file.
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_PATH = process.env.GITHUB_EDIT_PATH || 'web/content/site.json';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    res.status(200).send(await fs.readFile(path.join(process.cwd(), CONTENT_PATH), 'utf8'));
  } catch (e) {
    res.status(200).send('{}');
  }
}
