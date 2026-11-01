// Boot the configured local Workerd entry and exercise real HTTP routes. No deployment or wallet use.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, opendir, stat, rm, appendFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const OUT = resolve('.reports');
await mkdir(OUT, { recursive: true });
const state = await mkdtemp(join(OUT, 'runtime-state-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(OUT, 'runtime-server.log'));
const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state], {
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
child.stdout.pipe(log); child.stderr.pipe(log);
let terminal = false;
let interrupted = false;
const exited = new Promise((resolve) => { child.once('exit', (code, signal) => { terminal = true; resolve({ code, signal }); }); });
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ } };
process.once('SIGTERM', () => { interrupted = true; stop(); });
process.once('SIGINT', () => { interrupted = true; stop(); });
const report = { startedAt: new Date().toISOString(), status: 'incomplete', origin, localOnly: true, checks: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (path) => fetch(origin + path, { signal: AbortSignal.timeout(3000) });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (terminal || interrupted) throw new Error('Owned Worker process exited before readiness');
    try { const res = await request('/'); ready = res.status === 200 && (await res.text()).includes('MUSD Pay Links'); } catch { /* Boot in progress. */ }
    if (ready) break;
    await pause(250);
  }
  assert(ready, 'Configured Workerd entry must boot and serve the application');
  report.checks.push('Configured runtime booted and served the actual HTML');
  const asset = await request('/client.js');
  assert.equal(asset.status, 200, 'Built browser asset must be served by the real runtime');
  assert((await asset.text()).length > 100, 'Browser asset must contain an actual bundle');
  report.checks.push('Built browser asset served through the asset binding');
  const query = new URLSearchParams({ chain: '31611', to: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', amount: '1' });
  const linkResponse = await request('/api/link?' + query);
  assert.equal(linkResponse.status, 200);
  const payment = await linkResponse.json();
  assert(payment.ok && typeof payment.link === 'string');
  const accepted = await request('/api/check?' + new URLSearchParams({ link: payment.link, max: '1' }));
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).ok, true);
  const refused = await request('/api/check?' + new URLSearchParams({ link: payment.link, max: '0.5' }));
  assert.equal(refused.status, 422); assert.equal((await refused.json()).ok, false);
  report.checks.push('Real HTTP guard accepts the valid link and refuses an amount above the payer limit');
  report.status = 'passed'; report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Runtime smoke check failed';
  process.exitCode = 1; console.error(report.error);
} finally {
  stop();
  await Promise.race([exited, pause(3000)]);
  if (!terminal) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } await exited; }
  log.end();
  await writeFile(join(OUT, 'runtime-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  // Local fixtures are deleted only after the owned process stops and lsof reports no open files.
  // Hosted Linux runners lack macOS lsof semantics; there use lsof's equivalent return codes too.
  const open = spawnSync('lsof', ['-t', '+D', state], { encoding: 'utf8', timeout: 10_000 });
  if (open.status === 1 && !open.stdout.trim()) {
    async function size(path) {
      let bytes = 0;
      for await (const entry of await opendir(path)) {
        const file = join(path, entry.name);
        bytes += entry.isDirectory() ? await size(file) : (await stat(file)).size;
      }
      return bytes;
    }
    const bytes = await size(state);
    assert(bytes <= 50 * 1024 * 1024, 'Runtime fixture must stay below 50MB');
    await rm(state, { recursive: true });
    await appendFile(join(OUT, 'runtime-cleanup.jsonl'), JSON.stringify({ at: new Date().toISOString(), path: state, bytes, lsofClear: true }) + '\n');
  } else {
    await appendFile(join(OUT, 'runtime-cleanup.jsonl'), JSON.stringify({ at: new Date().toISOString(), path: state, deleted: false, reason: 'Open handles or unavailable lsof check' }) + '\n');
  }
}
