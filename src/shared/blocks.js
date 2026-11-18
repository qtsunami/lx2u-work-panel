// Browser-safe block model for the in-place Markdown editor. One block maps to
// one source line, so `parseBlocks`/`serializeBlocks` are lossless round trips.
// No imports, clock or DOM access.
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
const CHECK = /^\[( |x|X)\]\s+(.*)$/;

/** Classify one source line without changing it. */
export function blockStyle(source) {
  const line = String(source == null ? '' : source);
  const heading = HEADING.exec(line);
  if (heading) return { type: 'heading', level: heading[1].length, content: heading[2], ordered: false, checked: null };
  const quote = QUOTE.exec(line);
  if (quote) return { type: 'quote', content: quote[1], ordered: false, checked: null };
  const item = ITEM.exec(line);
  if (item) {
    const ordered = /\d/.test(item[2]);
    const check = CHECK.exec(item[3]);
    if (check) return { type: 'item', ordered: false, checked: check[1].toLowerCase() === 'x', content: check[2] };
    return { type: 'item', ordered, checked: null, content: item[3] };
  }
  return { type: 'paragraph', content: line, ordered: false, checked: null };
}

/** Split text into one block per line, preserving every character. */
export function parseBlocks(text) {
  const value = String(text == null ? '' : text);
  if (value === '') return [{ source: '', ...blockStyle('') }];
  return value.split('\n').map((source) => ({ source, ...blockStyle(source) }));
}

/** Join blocks back into the stored Markdown string. */
export function serializeBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => String(block && block.source != null ? block.source : '')).join('\n');
}

/** Physical prefix length of a block's marker, including its trailing spaces. */
export function markerLength(source) {
  const line = String(source == null ? '' : source);
  const match = /^[ \t]*(?:#{1,3}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(line);
  return match ? match[0].length : 0;
}

const MARKERS = {
  paragraph: '',
  heading: (level) => '#'.repeat(Math.min(3, Math.max(1, Number(level) || 1))) + ' ',
  bullet: '- ',
  ordered: '1. ',
  task: '- [ ] ',
  quote: '> ',
};

/** Strip the block marker but keep indentation, for retyping. */
export function stripMarker(source) {
  const line = String(source == null ? '' : source);
  const indent = (/^[ \t]*/.exec(line) || [''])[0];
  return indent + line.slice(markerLength(line));
}

/**
 * Turn a block into another type. Applying the type it already has removes the
 * marker instead, which makes toolbar buttons behave as toggles.
 */
export function setBlockType(source, type, level = 1) {
  const line = String(source == null ? '' : source);
  const current = blockStyle(line);
  const same = type === 'heading'
    ? current.type === 'heading' && current.level === Math.min(3, Math.max(1, Number(level) || 1))
    : type === 'bullet' ? current.type === 'item' && !current.ordered && current.checked === null
      : type === 'ordered' ? current.type === 'item' && current.ordered
        : type === 'task' ? current.type === 'item' && current.checked !== null
          : type === 'quote' ? current.type === 'quote'
            : current.type === 'paragraph';
  if (same && type !== 'paragraph') return stripMarker(line);
  const marker = MARKERS[type] === undefined ? '' : (typeof MARKERS[type] === 'function' ? MARKERS[type](level) : MARKERS[type]);
  const indent = (/^[ \t]*/.exec(line) || [''])[0];
  const body = line.slice(Math.max(indent.length, markerLength(line)));
  return indent + marker + body;
}

/** Newline inside a block: lists and quotes continue, headings start a paragraph. */
export function splitBlock(source, caret) {
  const line = String(source == null ? '' : source);
  // Splitting inside the marker keeps the marker on the left block.
  const at = Math.max(markerLength(line), Math.min(Number.isInteger(caret) ? caret : line.length, line.length));
  const style = blockStyle(line);
  const indent = (/^[ \t]*/.exec(line) || [''])[0];
  if (style.type === 'item' && style.content.trim() === '' && at >= line.length) {
    // Enter on an empty list item leaves the list instead of stacking empty items.
    return { left: stripMarker(line), right: '' };
  }
  const continuation = style.type === 'quote' ? indent + '> '
    : style.type === 'item' ? indent + setBlockType('', style.ordered ? 'ordered' : style.checked === null ? 'bullet' : 'task')
      : '';
  return { left: line.slice(0, at), right: continuation + line.slice(at) };
}

/** Backspace at the very start of a block: append this content to the previous line. */
export function mergeBlocks(previousSource, source) {
  const previous = String(previousSource == null ? '' : previousSource);
  const line = String(source == null ? '' : source);
  return previous + line.slice(markerLength(line));
}

/** Toggle a task checkbox line; returns null when the line is not a task item. */
export function toggleBlockCheckbox(source) {
  const line = String(source == null ? '' : source);
  const match = /^([ \t]*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](.*)$/.exec(line);
  if (!match) return null;
  return match[1] + '[' + (match[2] === ' ' ? 'x' : ' ') + ']' + match[3];
}

/** Ordinal for consecutive ordered items; other blocks reset the counter. */
export function orderedNumber(blocks, index) {
  let count = 0;
  for (let i = 0; i <= index && i < blocks.length; i += 1) {
    const block = blocks[i];
    const style = blockStyle(block && block.source);
    if (style.type === 'item' && style.ordered) count += 1;
    else if (i < index) count = 0;
  }
  return count || 1;
}
