// Maintained HTTP authorization journey, against auth-bench.mjs only.
export async function journey({ page, step, note, expect }) {
  const base = process.env.AUTH_PROOF_URL || 'http://127.0.0.1:24221';
  const weak = Boolean(process.env.AUTH_EXPECT_WEAK);
  const endpoints = ['save', 'history', 'upload', 'review', 'versions', 'agent-note', 'propose-post'];
  const results = [];
  for (const [mode, token, denied] of [
    ['missing-client', 'another-client', !weak],
    ['configured', 'another-client', true],
    ['configured', 'right-client', false],
    ['missing-admin', 'right-client', true],
    ['edit-token', 'synthetic-edit-token', false],
    ['configured', '', true],
  ]) {
    for (const endpoint of endpoints) {
      const r = await fetch(`${base}/${mode}/${endpoint}`, { method: endpoint === 'history' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(endpoint === 'history' ? {} : { body: '{}' }) });
      const body = await r.json();
      results.push({ mode, endpoint, token, status: r.status, error: body.error });
      expect(denied ? r.status === 401 : [400, 501].includes(r.status), `${mode}/${endpoint}: expected ${denied ? '401' : 'passed auth then safe validation failure'}, got ${r.status}`);
    }
  }
  for (const mode of ['missing-client', 'configured', 'edit-token']) {
    const r = await fetch(`${base}/${mode}/config`);
    const config = await r.json();
    expect(config.editable === (mode !== 'missing-client'), 'config advertises only configured auth');
    expect(!JSON.stringify(config).includes('synthetic-edit-token'), 'config never exposes the edit token');
    results.push({ mode, config });
  }
  const calls = await (await fetch(base + '/calls')).json();
  note('Real HTTP gate results and upstream fixture calls', { results, calls });
  await page.locator('#results').evaluate((el, value) => { el.textContent = value.map((r) => r.endpoint ? `${r.mode}/${r.endpoint}: HTTP ${r.status}` : `${r.mode}/config: editable=${r.config.editable}`).join('\n'); }, results);
  await step(weak ? 'unconfigured Google client accepts a token for another app' : 'missing configuration fails closed across seven handlers');
}
