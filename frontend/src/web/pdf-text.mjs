const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * PDF.js already emits literal spaces in most documents. A TextItem boundary
 * can also be just a font/glyph boundary, so it must not imply a space.
 * @typedef {{ str: string, hasEOL?: boolean, transform?: number[], width?: number, height?: number, dir?: string }} PdfTextItem
 */

/** @param {PdfTextItem} previous @param {PdfTextItem} current */
function hasWordGap(previous, current) {
  const left = [...previous.str].at(-1) || '';
  const right = [...current.str][0] || '';
  if (!wordCharacter.test(left) || !wordCharacter.test(right) || eastAsian.test(left) || eastAsian.test(right)) return false;
  if (previous.dir === 'rtl' || current.dir === 'rtl') return false;
  const before = previous.transform;
  const after = current.transform;
  if (!before || !after || before.length < 6 || after.length < 6 || !Number.isFinite(previous.width)) return false;
  const scale = Math.hypot(before[0], before[1]);
  if (!scale) return false;
  const horizontal = before[0] / scale;
  const vertical = before[1] / scale;
  const dx = after[4] - before[4];
  const dy = after[5] - before[5];
  const fontSize = Math.hypot(before[2], before[3]) || previous.height || scale;
  const baselineOffset = Math.abs(dx * -vertical + dy * horizontal);
  const gap = dx * horizontal + dy * vertical - /** @type {number} */ (previous.width);
  return baselineOffset < fontSize * 0.35 && gap > Math.max(0.5, fontSize * 0.12);
}

/**
 * Join one page of PDF.js text items without splitting Chinese words into
 * individual spaced glyphs. Geometry is only a fallback for Latin word gaps.
 * @param {ReadonlyArray<PdfTextItem>} items
 * @returns {string}
 */
export function joinPdfTextItems(items) {
  let output = '';
  /** @type {PdfTextItem | undefined} */
  let previous;
  for (const item of items) {
    if (item.str) {
      if (previous && !/\s$/u.test(output) && !/^\s/u.test(item.str) && hasWordGap(previous, item)) output += ' ';
      output += item.str;
      previous = item;
    }
    if (item.hasEOL) {
      if (!output.endsWith('\n')) output += '\n';
      previous = undefined;
    }
  }
  return output;
}
