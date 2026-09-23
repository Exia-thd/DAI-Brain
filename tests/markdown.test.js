import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../ui/public/markdown.js';

/*
 * Only the parser is tested. The renderer is `document.createElement` calls
 * with no branching left in them once the tree is right, and standing up a DOM
 * to assert on that would test jsdom, not this file.
 */

const flat = (tokens) => tokens.map((t) =>
  t.type === 'text' ? t.value
    : t.type === 'code' ? `\`${t.value}\``
      : t.type === 'break' ? '\n'
        : t.type === 'link' ? `[${flat(t.children)}](${t.href})`
          : `${t.type}(${flat(t.children)})`).join('');

test('the emphasis markers a model actually emits all resolve', () => {
  // The bug this exists for: `***text***` reaching the screen as asterisks.
  assert.equal(flat(parseInline('***both***')), 'strong(em(both))');
  assert.equal(flat(parseInline('**bold**')), 'strong(bold)');
  assert.equal(flat(parseInline('__bold__')), 'strong(bold)');
  assert.equal(flat(parseInline('*italic*')), 'em(italic)');
  assert.equal(flat(parseInline('_italic_')), 'em(italic)');
  assert.equal(flat(parseInline('~~gone~~')), 'strike(gone)');
  assert.equal(flat(parseInline('a **b** c *d*')), 'a strong(b) c em(d)');
});

test('an underscore inside a word is an underscore', () => {
  // `snake_case_name` is one identifier, not an emphasis run.
  assert.equal(flat(parseInline('snake_case_name here')), 'snake_case_name here');
  assert.equal(flat(parseInline('a_b and _real_ emphasis')), 'a_b and em(real) emphasis');
});

test('a code span wins over everything inside it', () => {
  assert.equal(flat(parseInline('`**not bold**`')), '`**not bold**`');
  assert.equal(flat(parseInline('use `a*b` and *this*')), 'use `a*b` and em(this)');
  assert.equal(flat(parseInline('`` a ` b ``')), '`a ` b`');
});

test('links are parsed, and only safe-looking ones keep their target', () => {
  assert.equal(flat(parseInline('[docs](https://x.dev/a)')), '[docs](https://x.dev/a)');
  assert.equal(flat(parseInline('see https://x.dev/a, then')), 'see [https://x.dev/a](https://x.dev/a), then');
  assert.equal(flat(parseInline('<https://x.dev>')), '[https://x.dev](https://x.dev)');
  // The renderer drops the href for anything not http/https/mailto; the parser
  // still reports what was written so that decision has something to act on.
  assert.equal(parseInline('[x](javascript:alert(1))')[0].href, 'javascript:alert(1');
});

test('a nested inline run does not restart the scan', () => {
  // A single shared /g/ regex made this input loop forever rather than fail.
  const tokens = parseInline('**a *b* c** tail');
  assert.equal(flat(tokens), 'strong(a em(b) c) tail');
});

test('headings, rules and fenced code are blocks', () => {
  const blocks = parseMarkdown('# One\n\ntext\n\n---\n\n```ts\nconst a = 1;\n```\n');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'rule', 'code']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[3].lang, 'ts');
  assert.equal(blocks[3].text, 'const a = 1;');
});

test('an unterminated fence still closes, because streaming has no other state', () => {
  const blocks = parseMarkdown('here:\n\n```sh\npnpm build');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'code']);
  assert.equal(blocks[1].text, 'pnpm build');
});

test('a single newline inside a paragraph is a line break', () => {
  const [block] = parseMarkdown('line one\nline two');
  assert.equal(flat(block.inline), 'line one\nline two');
});

test('lists nest, number, and carry checkboxes', () => {
  const [list] = parseMarkdown('- one\n- two\n  - deep\n');
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1].blocks[1].type, 'list');
  assert.equal(flat(list.items[1].blocks[1].items[0].blocks[0].inline), 'deep');

  const [ordered] = parseMarkdown('3. c\n4. d\n');
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 3);

  const [tasks] = parseMarkdown('- [x] done\n- [ ] todo\n');
  assert.deepEqual(tasks.items.map((i) => i.checked), [true, false]);
  assert.equal(flat(tasks.items[0].blocks[0].inline), 'done');
});

test('a rule of dashes is not a one-item list', () => {
  assert.deepEqual(parseMarkdown('---').map((b) => b.type), ['rule']);
  assert.deepEqual(parseMarkdown('***').map((b) => b.type), ['rule']);
});

test('a table needs its separator row to be a separator row', () => {
  const [table] = parseMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.equal(flat(table.head[0]), 'a');
  assert.equal(flat(table.rows[0][1]), '2');

  // Prose with a pipe in it is prose.
  assert.deepEqual(parseMarkdown('a | b\nnot a table').map((b) => b.type), ['paragraph']);
});

test('block quotes recurse', () => {
  const [quote] = parseMarkdown('> **why**\n> because\n');
  assert.equal(quote.type, 'quote');
  assert.equal(flat(quote.blocks[0].inline), 'strong(why)\nbecause');
});

test('a paragraph that follows a list is not swallowed by it', () => {
  const blocks = parseMarkdown('- one\n- two\n\nAfter the list.\n');
  assert.deepEqual(blocks.map((b) => b.type), ['list', 'paragraph']);
  assert.equal(flat(blocks[1].inline), 'After the list.');
});

test('no input loops or throws', () => {
  for (const source of ['', '   ', '*', '**', '```', '|', '- ', '>', '#', '1.', '~~~\n', '[](']) {
    assert.doesNotThrow(() => parseMarkdown(source), `input: ${JSON.stringify(source)}`);
  }
});
