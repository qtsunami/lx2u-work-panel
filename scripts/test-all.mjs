import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'tests/unit/test-parse.cjs', 'tests/host/test-host.mjs', 'tests/host/test-inbox-store.mjs', 'tests/host/test-workspace-store.mjs',
  'tests/integration/test-workspace-sync.mjs', 'tests/integration/test-integration-140.mjs', 'tests/unit/test-radar.mjs', 'tests/unit/test-auto-report.mjs',
  'tests/unit/test-search.mjs', 'tests/unit/test-recommendations.mjs', 'tests/unit/test-report-preferences.mjs', 'tests/ui/test-acceptance-ui.cjs', 'tests/ui/test-p1-ui.cjs', 'tests/ui/test-task-assistant.cjs',
  'tests/ui/test-stability.cjs', 'tests/ui/test-product-140.cjs', 'tests/ui/test-radar-ui.cjs', 'tests/unit/test-quick-date.mjs', 'tests/ui/test-quick-date-ui.cjs', 'tests/unit/test-markdown.mjs', 'tests/ui/test-markdown-ui.cjs', 'tests/ui/test-style-menu-ui.cjs',
  'tests/ui/test-render.cjs', 'tests/ui/test-detail-render.cjs', 'tests/ui/test-actions-render.cjs',
  'tests/ui/test-report-render.cjs', 'tests/ui/test-trash-render.cjs', 'tests/ui/test-project-render.cjs',
  'tests/ui/test-inbox-render.cjs', 'tests/ui/test-data-render.cjs',
  'tests/integration/test-client-build.mjs',
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
  const summary = result.stdout.split('\n').filter((line) => /ALL PASS|STABILITY:|WORKSPACE SYNC:|INTEGRATION 1.4:|^RADAR:|^AUTO-REPORT:|^RADAR UI 1\.5:|PRODUCT 1\.4:|RENDER OK|^# (tests|pass|fail) /.test(line)).join(' · ');
  console.log(`PASS ${suite}${summary ? ' — ' + summary : ''}`);
}
console.log(`ALL ${suites.length} SUITES PASSED`);
