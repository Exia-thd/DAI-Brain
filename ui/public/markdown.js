/**
 * Markdown for model output.
 *
 * Split in two on purpose: `parseMarkdown()` is pure and returns a token tree,
 * `renderMarkdown()` turns that tree into DOM nodes. The split is what lets the
 * grammar be tested in `tests/markdown.test.js` under plain Node, where there
 * is no `document` -- a renderer that only existed as DOM calls could only be
 * checked by looking at it.
 *
 * Nothing here ever produces an HTML string. The input is model output and
 * memory content, which is precisely the text you must never hand to a parser
 * that can create elements. Every node below is built with `createElement` and
 * every leaf is `textContent`, so a memory containing `<img onerror=...>` is a
 * memory containing those characters and nothing else.
 *
 * This is deliberately not CommonMark. Two knowing departures:
 *   - a single newline inside a paragraph is a line break, not a space, because
 *     chat answers are written to be read at the width they were typed;
 *   - an unterminated code fence still renders as a code block, because during
 *     streaming every fence is unterminated for a while and the alternative is
 *     the answer flickering between prose and code as it arrives.
 */

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/*
 * One alternation, tried left to right, so precedence is the order below.
 * Code spans come first: `**` inside a code span is two asterisks, and any
 * ordering that lets emphasis win there corrupts every snippet containing one.
 *
 *  1,2 code span      3,4 link       5 autolink    6 bold+italic
 *  7,8 bold            9 strike     10,11 italic  12 bare url
 *
 * Kept as source text rather than a compiled regex because `parseInline` is
 * recursive: one shared /g/ regex would have a nested call reset `lastIndex`
 * out from under the call that is still scanning, which is not a wrong result
 * but an endless one.
 */
const INLINE_SOURCE = [
  /(`+)([\s\S]*?)\1/.source,
  /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.source,
  /<((?:https?:\/\/|mailto:)[^>\s]+)>/.source,
  /\*\*\*([\s\S]+?)\*\*\*/.source,
  /\*\*([\s\S]+?)\*\*/.source,
  /__([\s\S]+?)__/.source,
  /~~([\s\S]+?)~~/.source,
  /\*([^\s*][\s\S]*?)\*/.source,
  /(?<![A-Za-z0-9_])_([^\s_][\s\S]*?)_(?![A-Za-z0-9_])/.source,
  /(https?:\/\/[^\s<>()[\]]+)/.source,
].join('|');

/** Trailing punctuation belongs to the sentence, not to the bare URL in it. */
function trimUrl(url) {
  const trimmed = url.replace(/[.,;:!?'"]+$/, '');
  return trimmed || url;
}

function text(value) {
  return { type: 'text', value };
}

/** Splits on newlines so a renderer can emit hard breaks without re-scanning. */
function textRun(value, out) {
  const parts = value.split('\n');
  parts.forEach((part, index) => {
    if (index > 0) out.push({ type: 'break' });
    if (part) out.push(text(part));
  });
}

export function parseInline(source) {
  const out = [];
  const scanner = new RegExp(INLINE_SOURCE, 'g');
  let last = 0;
  let match;
  while ((match = scanner.exec(source)) !== null) {
    if (match.index > last) textRun(source.slice(last, match.index), out);
    last = match.index + match[0].length;

    if (match[2] !== undefined) {
      // A code span's own padding spaces are delimiters, not content.
      out.push({ type: 'code', value: match[2].replace(/^ (.*) $/, '$1') });
    } else if (match[3] !== undefined) {
      out.push({ type: 'link', href: match[4], children: parseInline(match[3]) });
    } else if (match[5] !== undefined) {
      out.push({ type: 'link', href: match[5], children: [text(match[5])] });
    } else if (match[6] !== undefined) {
      out.push({ type: 'strong', children: [{ type: 'em', children: parseInline(match[6]) }] });
    } else if (match[7] !== undefined) {
      out.push({ type: 'strong', children: parseInline(match[7]) });
    } else if (match[8] !== undefined) {
      out.push({ type: 'strong', children: parseInline(match[8]) });
    } else if (match[9] !== undefined) {
      out.push({ type: 'strike', children: parseInline(match[9]) });
    } else if (match[10] !== undefined) {
      out.push({ type: 'em', children: parseInline(match[10]) });
    } else if (match[11] !== undefined) {
      out.push({ type: 'em', children: parseInline(match[11]) });
    } else if (match[12] !== undefined) {
      const url = trimUrl(match[12]);
      out.push({ type: 'link', href: url, children: [text(url)] });
      last = match.index + url.length;
      scanner.lastIndex = last;
    }
  }
  if (last < source.length) textRun(source.slice(last), out);
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^(\s{0,3})(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?/;
const MARKER = /^(\s*)(?:([-*+])|(\d{1,9})[.)])(\s+)(.*)$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function listMarker(line) {
  const m = MARKER.exec(line);
  if (!m) return null;
  // A rule made of `*` or `-` also matches the bullet pattern; it is not a list.
  if (RULE.test(line)) return null;
  const bulletWidth = m[2] ? 1 : m[3].length + 1;
  return {
    indent: m[1].length,
    ordered: m[3] !== undefined,
    number: m[3] ? Number(m[3]) : null,
    contentIndent: m[1].length + bulletWidth + m[4].length,
    text: m[5],
  };
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (/(?:^|[^\\])\|$/.test(row)) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** True only for a row of `---`, `:--`, `--:` or `:-:` cells. */
function alignments(line) {
  if (!line || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.length) return null;
  const align = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    align.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return align;
}

function startsBlock(line, next) {
  return !line.trim()
    || FENCE.test(line)
    || HEADING.test(line)
    || RULE.test(line)
    || QUOTE.test(line)
    || listMarker(line) !== null
    || (line.includes('|') && alignments(next) !== null);
}

export function parseMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const closing = new RegExp(`^\\s{0,3}${fence[2]}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ type: 'code', lang: fence[3] || '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push({ type: 'rule' }); i++; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      out.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }

    const align = line.includes('|') ? alignments(lines[i + 1]) : null;
    if (align) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i++]).map(parseInline));
      }
      out.push({ type: 'table', align, head, rows });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const { ordered } = marker;
      const start = marker.number ?? 1;
      const items = [];
      let loose = false;

      while (i < lines.length) {
        const item = listMarker(lines[i]);
        if (!item || item.ordered !== ordered || item.indent < marker.indent
            || item.indent > marker.indent + 3) break;

        const buffer = [item.text];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            // A blank line belongs to the item only if the item continues after
            // it; otherwise it ends the list. It also makes the list loose.
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && indentOf(lines[j]) >= item.contentIndent) {
              loose = true;
              buffer.push('');
              i = j;
              continue;
            }
            break;
          }
          if (indentOf(lines[i]) >= item.contentIndent) {
            buffer.push(lines[i++].slice(item.contentIndent));
            continue;
          }
          if (listMarker(lines[i]) || startsBlock(lines[i], lines[i + 1])) break;
          buffer.push(lines[i++].trim());
        }

        let body = buffer.join('\n');
        let checked = null;
        const task = /^\[([ xX])\]\s+/.exec(body);
        if (task) {
          checked = task[1].toLowerCase() === 'x';
          body = body.slice(task[0].length);
        }
        items.push({ checked, blocks: parseMarkdown(body) });
      }

      out.push({ type: 'list', ordered, start, loose, items });
      continue;
    }

    const paragraph = [lines[i++]];
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
    out.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n').trim()) });
  }

  return out;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/**
 * Only these schemes become an href.
 *
 * `javascript:` in a link the model wrote is the one way this renderer could
 * still execute something, so an unknown scheme is rendered as the text it is.
 */
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

function node(tag, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function copyButton(value) {
  const button = node('button', 'code-copy');
  button.type = 'button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
    } catch {
      // A page served over plain http to something other than localhost has no
      // clipboard API. Selecting the text is the next best thing we can offer.
      button.textContent = 'Press Ctrl+C';
      const range = document.createRange();
      range.selectNodeContents(button.closest('.code-block').querySelector('code'));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  });
  return button;
}

function renderInline(tokens, parent) {
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        parent.append(document.createTextNode(token.value));
        break;
      case 'break':
        parent.append(node('br'));
        break;
      case 'code': {
        const code = node('code', 'inline-code');
        code.textContent = token.value;
        parent.append(code);
        break;
      }
      case 'link': {
        if (!SAFE_SCHEME.test(token.href)) {
          renderInline(token.children, parent);
          break;
        }
        const link = node('a');
        link.href = token.href;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        renderInline(token.children, link);
        parent.append(link);
        break;
      }
      case 'strong':
        renderInline(token.children, parent.appendChild(node('strong')));
        break;
      case 'em':
        renderInline(token.children, parent.appendChild(node('em')));
        break;
      case 'strike':
        renderInline(token.children, parent.appendChild(node('del')));
        break;
      default:
        break;
    }
  }
  return parent;
}

function renderBlocks(blocks, parent) {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
        renderInline(block.inline, parent.appendChild(node('p')));
        break;

      case 'heading':
        renderInline(block.inline, parent.appendChild(node(`h${block.level}`)));
        break;

      case 'rule':
        parent.append(node('hr'));
        break;

      case 'code': {
        const wrap = node('div', 'code-block');
        const head = node('div', 'code-head');
        const lang = node('span', 'code-lang');
        lang.textContent = block.lang || 'text';
        head.append(lang, copyButton(block.text));
        const pre = node('pre');
        const code = node('code');
        code.textContent = block.text;
        pre.append(code);
        wrap.append(head, pre);
        parent.append(wrap);
        break;
      }

      case 'quote':
        renderBlocks(block.blocks, parent.appendChild(node('blockquote')));
        break;

      case 'list': {
        const list = node(block.ordered ? 'ol' : 'ul');
        if (block.ordered && block.start !== 1) list.start = block.start;
        for (const item of block.items) {
          const li = node('li');
          if (item.checked !== null) {
            li.classList.add('task');
            const box = node('input');
            box.type = 'checkbox';
            box.checked = item.checked;
            box.disabled = true;
            li.append(box);
          }
          // A tight item's own text reads as a line, not a block, so it goes
          // straight into the <li>: a <p> here would push a nested list onto
          // the next line and, on a task item, break it away from its checkbox.
          const [first, ...rest] = item.blocks;
          if (!block.loose && first?.type === 'paragraph') {
            renderInline(first.inline, li);
            renderBlocks(rest, li);
          } else {
            renderBlocks(item.blocks, li);
          }
          list.append(li);
        }
        parent.append(list);
        break;
      }

      case 'table': {
        const wrap = node('div', 'table-wrap');
        const table = node('table');
        const thead = node('thead');
        const headRow = node('tr');
        block.head.forEach((cell, index) => {
          const th = node('th');
          if (block.align[index]) th.style.textAlign = block.align[index];
          renderInline(cell, th);
          headRow.append(th);
        });
        thead.append(headRow);
        const tbody = node('tbody');
        for (const row of block.rows) {
          const tr = node('tr');
          row.forEach((cell, index) => {
            const td = node('td');
            if (block.align[index]) td.style.textAlign = block.align[index];
            renderInline(cell, td);
            tr.append(td);
          });
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        parent.append(wrap);
        break;
      }

      default:
        break;
    }
  }
  return parent;
}

export function renderMarkdown(source) {
  return renderBlocks(parseMarkdown(source), document.createDocumentFragment());
}
