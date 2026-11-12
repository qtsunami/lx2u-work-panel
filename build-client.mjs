import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The shipped client remains ONE loader script, while each reusable piece stays
// an independently tested, browser-safe module. Embedding keeps the runtime
// dependency-free: the browser cannot import relative helper files here.
const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
const resolve = (file) => fileURLToPath(new URL('./' + file, import.meta.url));

/** Browser-safe modules embedded verbatim (minus `export`) into client.js. */
const candidates = ['workspace-sync.js', 'radar.js', 'auto-report.js'];

/** Keep every generated region identical to its canonical source. */
function embed(current, file) {
  const source = readFileSync(resolve(file), 'utf8');
  if (/^\s*(import|require)\s/m.test(source) || /\brequire\s*\(/.test(source)) {
    throw new Error(file + ' must remain self-contained browser-safe source (no imports)');
  }
  if (/\b(window|document|localStorage|process)\s*\./.test(source)) {
    throw new Error(file + ' must not reference browser or Node globals');
  }
  const key = file.replace(/\.js$/, '');
  const start = '    // @generated ' + key + ' begin';
  const end = '    // @generated ' + key + ' end';
  const first = current.indexOf(start);
  const last = current.indexOf(end);
  if (first < 0 || last < first || current.indexOf(start, first + 1) >= 0) {
    throw new Error('missing or duplicated generated region for ' + file);
  }
  const body = source.replace(/^export\s+/gm, '').trimEnd()
    .split('\n').map((line) => (line ? '    ' + line : '')).join('\n');
  return current.slice(0, first) + start + '\n'
    + '    // Generated from ' + file + ' by build-client.mjs; do not edit this region.\n'
    + body + '\n' + current.slice(last);
}

// A module participates once its canonical source exists; from then on it must
// also have a generated region, so a forgotten embed fails loudly.
const modules = candidates.filter((file) => existsSync(resolve(file)));
let next = readFileSync(clientPath, 'utf8');
for (const file of modules) next = embed(next, file);

if (process.argv.includes('--check')) {
  if (next !== readFileSync(clientPath, 'utf8')) {
    throw new Error('Embedded browser-safe modules are stale. Run: node build-client.mjs');
  }
  console.log('CLIENT BUILD PARITY OK (' + modules.length + ' modules: ' + modules.join(', ') + ')');
} else {
  writeFileSync(clientPath, next, 'utf8');
  console.log('Embedded into client.js: ' + modules.join(', '));
}
