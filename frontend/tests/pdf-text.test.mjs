import assert from 'node:assert/strict';
import test from 'node:test';
import { joinPdfTextItems } from '../src/web/pdf-text.mjs';

const item = (str, x, width, extra = {}) => ({ str, transform: [12, 0, 0, 12, x, 100], width, height: 12, ...extra });

test('CJK glyph items remain continuous, including exported Chinese meeting titles', () => {
  const title = '已重命名的验收会议';
  const items = [...title].map((character, index) => item(character, index * 13, 12));
  assert.equal(joinPdfTextItems(items), title);
  assert.equal(joinPdfTextItems([{ str: '中文' }, { str: 'AI' }, { str: '会议。' }]), '中文AI会议。');
  assert.equal(joinPdfTextItems([{ str: '日本語' }, { str: 'テスト' }, { str: '한국어' }]), '日本語テスト한국어');
});

test('literal PDF.js spaces are preserved without adding spaces around punctuation', () => {
  assert.equal(joinPdfTextItems([{ str: 'Hello' }, { str: ' ' }, { str: 'world' }, { str: '!' }]), 'Hello world!');
  assert.equal(joinPdfTextItems([{ str: '中文' }, { str: '  ' }, { str: 'English' }]), '中文  English');
  assert.equal(joinPdfTextItems([{ str: 'Hello ' }, { str: 'world' }]), 'Hello world');
});

test('Latin word gaps use PDF positions while fragments of one word remain joined', () => {
  assert.equal(joinPdfTextItems([item('Hel', 0, 18), item('lo', 18, 12), item('world', 34, 30)]), 'Hello world');
  assert.equal(joinPdfTextItems([{ str: 'Hel' }, { str: 'lo' }]), 'Hello');
  // A different baseline is not a horizontal word gap.
  assert.equal(joinPdfTextItems([item('one', 0, 18), item('two', 30, 18, { transform: [12, 0, 0, 12, 30, 80] })]), 'onetwo');
});

test('hasEOL preserves line boundaries, including empty end-of-line items', () => {
  assert.equal(joinPdfTextItems([{ str: '第一行', hasEOL: true }, { str: 'Second' }, { str: ' line', hasEOL: true }]), '第一行\nSecond line\n');
  assert.equal(joinPdfTextItems([{ str: '第一行' }, { str: '', hasEOL: true }, { str: '第二行' }]), '第一行\n第二行');
  assert.equal(joinPdfTextItems([{ str: 'one\n', hasEOL: true }, { str: 'two' }]), 'one\ntwo');
});
