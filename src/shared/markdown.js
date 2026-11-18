// Browser-safe Markdown subset for task descriptions. No imports, clock or DOM.
// The renderer produces React elements, never HTML, so untrusted text cannot
// inject markup. Block lines keep their source line number for checkbox writes.
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const CHECK_RE = /^\[( |x|X)\]\s+(.*)$/;
const INLINE_RE = /\[\[task:([A-Za-z0-9_-]+)\]\]|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function listItem(content, line, depth) {
  const checked = CHECK_RE.exec(content);
  if (checked) return { text: checked[2], checked: checked[1].toLowerCase() === 'x', line, depth };
  return { text: content, checked: null, line, depth };
}

/** Parse block structure; blank lines separate blocks and are not kept. */
export function parseMarkdown(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  let paragraph = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\s+$/, '');
    if (!raw.trim()) { paragraph = null; continue; }
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim(), line: i });
      paragraph = null;
      continue;
    }
    const quote = QUOTE_RE.exec(raw);
    if (quote) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'quote' && last.endLine === i - 1) {
        last.text += '\n' + quote[1];
        last.endLine = i;
      } else {
        blocks.push({ type: 'quote', text: quote[1], line: i, endLine: i });
      }
      paragraph = null;
      continue;
    }
    const item = LIST_RE.exec(raw);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const indent = item[1].replace(/\t/g, '  ').length;
      const entry = listItem(item[3], i, Math.min(2, Math.floor(indent / 2)));
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'list' && last.ordered === ordered && last.endLine === i - 1) {
        last.items.push(entry);
        last.endLine = i;
      } else {
        blocks.push({ type: 'list', ordered, items: [entry], line: i, endLine: i });
      }
      paragraph = null;
      continue;
    }
    if (paragraph) {
      paragraph.text += '\n' + raw.trim();
      paragraph.endLine = i;
    } else {
      paragraph = { type: 'paragraph', text: raw.trim(), line: i, endLine: i };
      blocks.push(paragraph);
    }
  }
  return blocks;
}

/** Split one block's text into plain and marked inline tokens. */
export function parseInline(text) {
  const source = String(text == null ? '' : text);
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let match = INLINE_RE.exec(source);
  while (match !== null) {
    if (match.index > last) out.push({ type: 'text', text: source.slice(last, match.index) });
    if (match[1]) out.push({ type: 'task', id: match[1] });
    else if (match[2] !== undefined) out.push({ type: 'code', text: match[2] });
    else if (match[3] !== undefined) out.push({ type: 'strong', text: match[3] });
    else if (match[4] !== undefined) out.push({ type: 'em', text: match[4] });
    else out.push({ type: 'link', text: match[5], href: match[6] });
    last = match.index + match[0].length;
    match = INLINE_RE.exec(source);
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}

/** Flip one task-list checkbox line; returns null when that line is not one. */
export function toggleCheckboxAtLine(text, line) {
  const lines = String(text == null ? '' : text).split('\n');
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
  const match = /^([ \t]*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(lines[line]);
  if (!match) return null;
  lines[line] = match[1] + '[' + (match[2] === ' ' ? 'x' : ' ') + ']' + lines[line].slice(match[0].length);
  return lines.join('\n');
}

/** Single-line plain summary for list rows, with block and inline markers removed. */
export function markdownToPlainText(text) {
  const source = String(text == null ? '' : text);
  const flat = parseMarkdown(source).map((block) => {
    if (block.type === 'heading') return block.text;
    if (block.type === 'quote') return block.text;
    if (block.type === 'list') return block.items.map((item) => item.text).join(' ');
    return block.text;
  }).join(' ');
  return parseInline(flat).map((token) => {
    if (token.type === 'task') return '';
    if (token.type === 'link') return token.text;
    return token.text != null ? token.text : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Toggle a block prefix on every line the caret/selection touches. Returns the
 * new text and selection so the caller can restore the caret after rendering.
 */
export function applyBlockPrefix(text, start, end, prefix) {
  const source = String(text == null ? '' : text);
  const from = Math.max(0, Math.min(Number(start) || 0, source.length));
  const to = Math.max(from, Math.min(Number(end) || 0, source.length));
  const lineStart = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEndIndex = source.indexOf('\n', to);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  const lines = source.slice(lineStart, lineEnd).split('\n');
  const remove = lines.every((line) => line.startsWith(prefix));
  const caretLine = (source.slice(lineStart, from).match(/\n/g) || []).length;
  const next = lines.map((line) => {
    // Toggling a bullet off a checkbox item must remove the checkbox marker too.
    if (remove) return line.slice(prefix.length).replace(/^\[[ xX]\]\s+/, '');
    if (line.startsWith(prefix)) return line;
    // Replace an existing heading/list marker instead of stacking a new one, and
    // keep the original indentation so nested items keep their level.
    const indent = (/^[ \t]*/.exec(line) || [''])[0];
    const rest = line.slice(indent.length)
      .replace(/^(?:#{1,3}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, '');
    return indent + prefix + rest;
  });
  const caretLineText = lines[caretLine] || '';
  const caretIndent = (/^[ \t]*/.exec(caretLineText) || [''])[0].length;
  const caretMarker = (caretLineText.slice(caretIndent)
    .match(/^(?:#{1,3}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/) || [''])[0].length;
  const nextLineText = next[caretLine] || '';
  const nextIndent = (/^[ \t]*/.exec(nextLineText) || [''])[0].length;
  const offsetInLine = from - lineStart;
  // Editing the marker itself should land the caret after the new marker, not
  // one character into it.
  const caretAfter = remove
    ? (offsetInLine <= caretIndent + caretMarker ? lineStart + nextIndent : Math.max(lineStart, from - (caretLineText.length - nextLineText.length)))
    : (offsetInLine <= caretIndent + caretMarker ? lineStart + nextIndent + prefix.length
      : Math.max(lineStart, from + (nextLineText.length - caretLineText.length)));
  const endAfter = to === from ? caretAfter : Math.max(caretAfter, to + (next[caretLine].length - caretLineText.length));
  return {
    text: source.slice(0, lineStart) + next.join('\n') + source.slice(lineEnd),
    selectionStart: caretAfter,
    selectionEnd: endAfter,
  };
}

/**
 * Detect a style trigger at the caret: `、` or `/` on an empty-line start or
 * right after a space/tab. Returns the trigger index and where to start removing.
 */
export function styleTriggerAt(value, caret) {
  const text = String(value == null ? '' : value);
  const pos = Number.isInteger(caret) ? caret : text.length;
  if (pos < 1 || pos > text.length) return null;
  const trigger = text[pos - 1];
  if (trigger !== '、' && trigger !== '/') return null;
  const before = text[pos - 2];
  const lineStart = pos - 1 === 0 || before === '\n';
  const spaced = before === ' ' || before === '\t';
  if (!lineStart && !spaced) return null;
  return { index: pos - 1, trigger, removeStart: spaced ? pos - 2 : pos - 1 };
}

/** Remove the trigger character and one preceding space, if present. */
export function removeStyleTrigger(value, index) {
  const text = String(value == null ? '' : value);
  if (!Number.isInteger(index) || index < 0 || index >= text.length) return text;
  const before = text[index - 1];
  const from = before === ' ' || before === '\t' ? index - 1 : index;
  return text.slice(0, from) + text.slice(index + 1);
}

/** Replace the selection with a task marker and place the caret after it. */
export function insertTaskRef(text, start, end, id) {
  const source = String(text == null ? '' : text);
  const marker = '[[task:' + String(id || '') + ']]';
  const from = Math.max(0, Math.min(Number(start) || 0, source.length));
  const to = Math.max(from, Math.min(Number(end) || 0, source.length));
  return {
    text: source.slice(0, from) + marker + source.slice(to),
    selectionStart: from + marker.length,
    selectionEnd: from + marker.length,
  };
}
