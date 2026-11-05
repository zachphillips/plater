// The verify bench: the PRODUCTION server (`plater serve`, real /api/config,
// real /api/save with its auth gate) running examples/static-site out of a
// fresh temp git repo. The only stand-in is GitHub itself: calls to the
// Contents API for the bench repo are answered from that temp repo, and a PUT
// becomes a real `git commit` there. So a save that passes the gate leaves a
// commit you can `git log`, and a save that fails it leaves nothing.
//
//   node verify/bench.mjs        start it and keep it up (prints url, token,
//                                site dir as one JSON line) for manual or
//                                `evidence` drives; Ctrl-C to stop
//   import { startBench }        what verify/editor.mjs uses
//
// Nothing here can reach a real GitHub or Google: GITHUB_TOKEN is a throwaway
// value, CMS_ADMIN_EMAIL is unset (so Google auth fails closed before any
// network call), and any other GitHub or Google request throws.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'plater-verify/bench-site';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function makeSite() {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plater-bench-'));
  fs.cpSync(path.join(ROOT, 'examples/static-site'), siteDir, { recursive: true });
  // `serve` never exposes the Plater checkout, so vendor the client modules
  // into the site the way a real install does.
  for (const pkg of ['core', 'capture']) {
    fs.cpSync(path.join(ROOT, 'packages', pkg, 'src'), path.join(siteDir, 'packages', pkg, 'src'), { recursive: true });
  }
  fs.rmSync(path.join(siteDir, '.plater-review.json'), { force: true });
  git(siteDir, 'init', '-q', '-b', 'main');
  git(siteDir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'add', '-A');
  git(siteDir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'bench: initial site');
  return siteDir;
}

// The GitHub Contents API, as far as save.js uses it: GET (sha + base64
// content, 404 when absent) and PUT (sha must match HEAD's blob, else 409).
function fakeGitHub(siteDir, githubToken) {
  const prefix = `https://api.github.com/repos/${REPO}/contents/`;
  const realFetch = globalThis.fetch;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(prefix)) {
      const headers = new Headers(init.headers || {});
      if (headers.get('authorization') !== `Bearer ${githubToken}`) return reply(401, { message: 'Bad credentials' });
      const rel = decodeURIComponent(new URL(url).pathname.slice(new URL(prefix).pathname.length));
      const file = path.resolve(siteDir, rel);
      if (!file.startsWith(siteDir + path.sep)) return reply(404, { message: 'Not Found' });
      const blobSha = () => git(siteDir, 'rev-parse', `HEAD:${rel}`);
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'GET') {
        let sha; try { sha = blobSha(); } catch { return reply(404, { message: 'Not Found' }); }
        return reply(200, { sha, encoding: 'base64', content: Buffer.from(git(siteDir, 'show', `HEAD:${rel}`) + '\n').toString('base64') });
      }
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        let current = null; try { current = blobSha(); } catch {}
        if ((body.sha || null) !== current) return reply(409, { message: `${rel} does not match ${body.sha}` });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(body.content, 'base64'));
        git(siteDir, 'add', rel);
        execFileSync('git', ['-C', siteDir, 'commit', '-q', '-m', body.message], {
          env: { ...process.env, GIT_AUTHOR_NAME: body.author?.name || 'Plater CMS', GIT_AUTHOR_EMAIL: body.author?.email || 'plater@localhost', GIT_COMMITTER_NAME: body.committer?.name || 'Plater CMS', GIT_COMMITTER_EMAIL: body.committer?.email || 'plater@localhost' },
        });
        return reply(200, { commit: { sha: git(siteDir, 'rev-parse', 'HEAD') } });
      }
      return reply(405, { message: 'method not allowed' });
    }
    if (/^https:\/\/([a-z0-9-]+\.)*(github|googleapis|google)\.com\//i.test(url)) {
      throw new Error(`verify bench: refused a real network call to ${new URL(url).host}`);
    }
    return realFetch(input, init);
  };
}

export async function startBench({ port = 4290 } = {}) {
  const siteDir = makeSite();
  const editToken = crypto.randomBytes(18).toString('base64url');
  const githubToken = 'bench-' + crypto.randomBytes(8).toString('hex');
  Object.assign(process.env, {
    CMS_EDIT_TOKEN: editToken,
    GITHUB_TOKEN: githubToken,
    GITHUB_REPOSITORY: REPO,
    GITHUB_BRANCH: 'main',
    CMS_SITE_NAME: 'bench-site',
  });
  for (const key of ['CMS_ADMIN_EMAIL', 'GOOGLE_CLIENT_ID', 'CMS_DEPLOY_HOOK', 'GITHUB_EDIT_PATH', 'PLATER_AGENT_ENDPOINT', 'ZMS_AGENT_ENDPOINT']) delete process.env[key];
  // The handlers resolve GITHUB_EDIT_PATH against the working directory.
  process.chdir(siteDir);
  fakeGitHub(siteDir, githubToken);
  const { startServe } = await import('../cli/serve.mjs');
  const served = await startServe(siteDir, { port, host: '127.0.0.1' });
  return {
    url: `http://127.0.0.1:${served.port}/`,
    editToken,
    siteDir,
    contentPath: served.contentPath,
    commits: () => Number(git(siteDir, 'rev-list', '--count', 'HEAD')),
    lastCommit: () => git(siteDir, 'log', '-1', '--format=%H%x1f%s%x1f%an'),
    content: () => JSON.parse(fs.readFileSync(served.contentPath, 'utf8')),
    close: () => new Promise((resolve) => served.server.close(() => resolve())),
  };
}

const entry = (() => { try { return fs.realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const bench = await startBench({ port: Number(process.env.PORT) || 4290 });
  console.log(JSON.stringify({ url: bench.url, editToken: bench.editToken, siteDir: bench.siteDir }));
}
