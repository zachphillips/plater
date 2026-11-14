import { startBench } from './bench.mjs';
process.env.PLATER_LIVE = process.env.AUTOSAVE_LIVE_STREAM === '1' ? '1' : '0';
const bench = await startBench({ port: Number(process.env.PORT || 25041) });
console.log(JSON.stringify({ url: bench.url, siteDir: bench.siteDir, editToken: bench.editToken, contentPath: bench.contentPath }));
