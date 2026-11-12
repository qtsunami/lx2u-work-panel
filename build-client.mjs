import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The shipped client remains a single loader script. Keep the independently
// tested, browser-safe synchronization class identical to its canonical source.
const path = fileURLToPath(new URL('./client.js', import.meta.url));
const source = readFileSync(new URL('./workspace-sync.js', import.meta.url), 'utf8');
if (/^\s*import\s/m.test(source) || !source.includes('export class WorkspaceSync')) {
  throw new Error('workspace-sync.js must remain self-contained browser-safe source');
}
const start = '    // @generated workspace-sync begin';
const end = '    // @generated workspace-sync end';
const current = readFileSync(path, 'utf8');
const first = current.indexOf(start);
const last = current.indexOf(end);
if (first < 0 || last < first || current.indexOf(start, first + 1) >= 0) throw new Error('invalid generated client region');
const body = source.replace('export class WorkspaceSync', 'class WorkspaceSync').trimEnd()
  .split('\n').map((line) => line ? '    ' + line : '').join('\n');
const next = current.slice(0, first) + start + '\n'
  + '    // Generated from workspace-sync.js by build-client.mjs; do not edit this region.\n'
  + body + '\n' + current.slice(last);
if (process.argv.includes('--check')) {
  if (next !== current) throw new Error('Embedded synchronization code is stale. Run: node build-client.mjs');
  console.log('CLIENT BUILD PARITY OK');
} else {
  writeFileSync(path, next, 'utf8');
  console.log('Embedded canonical WorkspaceSync into client.js');
}
