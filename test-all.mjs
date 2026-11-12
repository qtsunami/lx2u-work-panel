import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const suites = [
  'test-parse.cjs', 'test-host.mjs', 'test-inbox-store.mjs', 'test-workspace-store.mjs',
  'test-workspace-sync.mjs', 'test-integration-140.mjs', 'test-stability.cjs', 'test-product-140.cjs',
  'test-render.cjs', 'test-detail-render.cjs', 'test-actions-render.cjs',
  'test-report-render.cjs', 'test-trash-render.cjs', 'test-project-render.cjs',
  'test-inbox-render.cjs', 'test-data-render.cjs',
];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [suite], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    console.error(`FAIL ${suite}`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error);
    process.exit(1);
  }
  const summary = result.stdout.split('\n').filter((line) => /ALL PASS|STABILITY:|WORKSPACE SYNC:|INTEGRATION 1.4:|PRODUCT 1\.4:|RENDER OK|^# (tests|pass|fail) /.test(line)).join(' · ');
  console.log(`PASS ${suite}${summary ? ' — ' + summary : ''}`);
}
console.log(`ALL ${suites.length} SUITES PASSED`);
