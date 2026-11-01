// Preserve actual Vitest results and their source revision. This script runs no tests and signs nothing.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [mode, input] = process.argv.slice(2);
if (!['offline', 'live'].includes(mode) || !input) throw new Error('Usage: record-test-evidence.mjs offline|live REPORT.json');
if (mode === 'live' && process.env.LIVE !== '1') throw new Error('A live report requires LIVE=1 from the test run');
const bytes = await readFile(input);
const report = JSON.parse(bytes.toString('utf8'));
for (const field of ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']) {
  if (!Number.isSafeInteger(report[field]) || report[field] < 0) throw new Error(`Invalid runner field: ${field}`);
}
if (typeof report.success !== 'boolean' || !Array.isArray(report.testResults)) throw new Error('Missing actual Vitest result fields');
const assertions = report.testResults.flatMap((file) => file.assertionResults ?? []);
if (assertions.length !== report.numTotalTests) throw new Error('Runner assertion count does not match its summary');
const assertionCounts = {};
for (const test of assertions) assertionCounts[test.status] = (assertionCounts[test.status] ?? 0) + 1;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('Report checkout differs from the workflow source commit');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const summary = {
  recordedAt: new Date().toISOString(),
  commit,
  mode,
  liveEnvironment: process.env.LIVE === '1',
  command: `pnpm exec vitest run --reporter=default --reporter=json --outputFile=${input}`,
  runnerReport: input,
  reportSha256: createHash('sha256').update(bytes).digest('hex'),
  success: report.success,
  counts: {
    collected: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skippedOrPending: report.numPendingTests,
    todo: report.numTodoTests ?? 0,
  },
  assertionCounts,
  runtime: { node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), packageManager: pkg.packageManager },
  workflow: process.env.GITHUB_RUN_ID ? {
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  } : null,
  limits: ['Tests using fake providers are not browser-wallet proof.', 'Read-only live RPC tests do not prove a new payment or outside adoption.'],
};
const output = input.replace(/\.json$/, '') + '-summary.json';
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
