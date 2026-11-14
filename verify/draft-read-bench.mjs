// Actual authenticated production server, synthetic files and no real network.
import fs from 'node:fs';
import path from 'node:path';
import { startBench } from './bench.mjs';
const bench = await startBench({ port: Number(process.env.PORT || 24941) });
const versions = path.join(bench.siteDir, 'content', 'versions');
fs.mkdirSync(path.join(versions, 'safe'), { recursive: true });
fs.writeFileSync(path.join(versions, 'safe', 'site.json'), JSON.stringify({ hero: { headline: 'A safe draft inside content' } }));
fs.writeFileSync(path.join(versions, 'safe', 'index.md'), 'A safe draft document inside content');
const outside = path.join(bench.siteDir, 'private-fixture');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'site.json'), JSON.stringify({ private: 'synthetic-private-draft-sentinel' }));
fs.writeFileSync(path.join(outside, 'index.md'), 'synthetic-private-draft-sentinel');
fs.symlinkSync(outside, path.join(versions, 'outside'));
fs.symlinkSync(path.join(outside, 'site.json'), path.join(versions, 'safe', 'leaked.json'));
fs.symlinkSync(path.join(outside, 'index.md'), path.join(versions, 'safe', 'leaked.md'));
console.log(JSON.stringify({ url: bench.url, siteDir: bench.siteDir, editToken: bench.editToken }));
