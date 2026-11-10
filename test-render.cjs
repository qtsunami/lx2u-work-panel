// Smoke test: render the WorkPanel component with a minimal React mock.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

const React = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props, children }),
};
const mockRequire = (spec) => {
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
};

let captured;
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => { captured = reg; } } },
  console, Date, JSON, Math,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const plugin = captured.factory(mockRequire);

const registered = {};
plugin.apply({
  slots: {
    inject: (owner, fn) => fn(),
    register: (spec, comp) => { registered[spec.key || spec.id] = comp; return () => {}; },
  },
});

const WorkPanel = registered['work-panel'];
if (typeof WorkPanel !== 'function') throw new Error('WorkPanel not registered');

const tree = WorkPanel();
if (!tree || tree.type !== 'div') throw new Error('unexpected tree');
const classes = [];
(function walk(node) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (typeof node !== 'object') return;
  if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
  (node.children || []).forEach(walk);
})(tree);

const want = ['wp-root', 'wp-workbench', 'wp-sidenav', 'wp-mid', 'wp-mid-head', 'wp-search-input'];
const missing = want.filter((c) => !classes.some((x) => x.split(' ').includes(c)));
if (missing.length) throw new Error('missing classes: ' + missing.join(','));
console.log('RENDER OK · ' + classes.length + ' nodes · ' + want.join(', '));
