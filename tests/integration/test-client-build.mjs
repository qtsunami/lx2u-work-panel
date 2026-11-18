import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Build fault injection runs only in our disposable fixture, never the checkout.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'work-panel-build-')));
const safe = (relative) => {
  const target = resolve(fixture, relative);
  assert.ok(target.startsWith(fixture + '/'), 'fixture path must stay inside owned directory');
  return target;
};
const run = (...args) => {
  const result = spawnSync(process.execPath, [safe('scripts/build-client.mjs'), ...args], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error);
  return result;
};
try {
  mkdirSync(safe('scripts'), { recursive: true });
  cpSync(join(root, 'scripts/build-client.mjs'), safe('scripts/build-client.mjs'));
  cpSync(join(root, 'src'), safe('src'), { recursive: true });
  assert.equal(run().status, 0, 'build works from a different working directory');
  assert.equal(readFileSync(safe('client.js'), 'utf8'), readFileSync(join(root, 'client.js'), 'utf8'), 'clean source reproduces checked-in output');
  assert.equal(run('--check').status, 0);
  const generated = readFileSync(safe('client.js'), 'utf8');
  writeFileSync(safe('src/client/main.js'), readFileSync(safe('src/client/main.js'), 'utf8') + '\n// changed fixture\n');
  assert.notEqual(run('--check').status, 0, 'stale output is rejected');
  assert.equal(readFileSync(safe('client.js'), 'utf8'), generated, '--check never rewrites output');
  assert.equal(run().status, 0);
  const source = safe('src/shared/quick-date.js'), saved = safe('src/shared/quick-date.saved');
  assert.ok(existsSync(source) && !existsSync(saved));
  renameSync(source, saved);
  const missing = run();
  assert.notEqual(missing.status, 0, 'missing required module cannot be skipped');
  assert.match(missing.stderr, /quick-date/);
  assert.ok(existsSync(saved) && !existsSync(source));
  renameSync(saved, source);
  writeFileSync(source, "import x from 'not-browser-safe';\n" + readFileSync(source, 'utf8'));
  assert.notEqual(run().status, 0, 'unsafe imports fail before runtime');
  cpSync(join(root, 'src/shared/quick-date.js'), source);
  const template = safe('src/client/main.js');
  writeFileSync(template, readFileSync(template, 'utf8') + '\n    // @generated quick-date end\n');
  assert.notEqual(run().status, 0, 'duplicate generation slots are rejected');
  console.log('CLIENT BUILD: reproducibility, cwd, stale output, missing module and invalid source passed');
} finally {
  assert.equal(realpathSync(fixture), fixture);
  assert.ok(basename(fixture).startsWith('work-panel-build-'));
  assert.equal(resolve(fixture, '..'), realpathSync(tmpdir()));
  rmSync(fixture, { recursive: true, force: true });
}
