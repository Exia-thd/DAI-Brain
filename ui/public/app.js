/**
 * DAI Brain UI.
 *
 * No framework and no build step: this is a debugging tool for its own author
 * before it is anything else, and a build pipeline between a change and seeing
 * it costs more here than it returns.
 *
 * The UI knows only the six event types in shared/src/events.ts. It never
 * learns that a Claude CLI exists, which is what lets the Runner be swapped
 * without touching this file.
 */

import { renderMarkdown } from './markdown.js';

const api = {
  token: localStorage.getItem('dai-brain-token') || null,
  headers(extra = {}) {
    const h = { 'content-type': 'application/json', ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  },
  async get(path) {
    const r = await fetch(path, { headers: this.headers() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
    return r.status === 204 ? null : r.json();
  },
};

const state = {
  conversationId: null,
  streaming: false,
  abort: null,
  /** id -> citation, so a chip clicked later can still be resolved. */
  citations: new Map(),
  /** Running cost of the open conversation, shown in the status bar. */
  spend: null,
  costCeiling: 0,
  /** Attachments still being read off disk. */
  staging: 0,
};

const THEME_KEY = 'dai-brain-theme';

/*
 * Kept in step with the Gateway's defaults rather than fetched.
 *
 * Checking here is a courtesy -- it turns a refused round trip into an
 * immediate sentence -- so it is allowed to be out of date. The Gateway
 * enforces the real limits, because a client-side limit protects nobody.
 */
const ATTACH_LIMITS = { count: 10, totalBytes: 5 * 1024 * 1024 };

/** Files staged for the next message: {name, type, size, data}. */
state.attachments = [];

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: the text here is model output and memory
  // content, which is exactly the input you must never hand to a parser.
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function clearEmptyState() {
  $('messages').querySelector('.empty')?.remove();
}

/**
 * The assistant body keeps the raw markdown and is re-rendered from it.
 *
 * Appending rendered nodes as deltas arrive cannot work: `**` is not emphasis
 * until its closing pair lands, and a line is not a list until the next one
 * agrees. Re-rendering a few kilobytes on a frame is cheap; guessing is not.
 *
 * The user's own text is not rendered as markdown. They wrote those asterisks
 * on purpose, and seeing their message come back reformatted is disorienting
 * in a way that seeing the model's output formatted is not.
 */
function addMessage(role, text = '', attachments = []) {
  clearEmptyState();
  const wrap = el('div', `msg ${role}`);

  if (role === 'user') {
    const bubble = el('div', 'bubble');
    if (attachments.length > 0) {
      const strip = el('div', 'bubble-files');
      for (const attachment of attachments) {
        strip.append(el('span', 'chip', `${attachment.name} · ${fileSize(attachment.size)}`));
      }
      bubble.append(strip);
    }
    bubble.append(el('div', 'bubble-text', text));
    wrap.append(bubble);
    $('messages').append(wrap);
    scrollToBottom();
    return { wrap, raw: text };
  }

  wrap.append(el('div', 'avatar', '\u{1F9E0}'));
  const stack = el('div', 'stack');
  const tools = el('div', 'tools');
  tools.hidden = true;
  const body = el('div', 'body prose');
  const citations = el('div', 'citations');
  citations.hidden = true;
  stack.append(tools, body, citations);
  wrap.append(stack);
  $('messages').append(wrap);

  const view = { wrap, tools, body, citations, raw: '', frame: 0 };
  if (text) { view.raw = text; renderBody(view); }
  scrollToBottom();
  return view;
}

function renderBody(view) {
  view.body.textContent = '';
  view.body.append(renderMarkdown(view.raw));
}

/** Coalesces a burst of deltas into one render per frame. */
function scheduleRender(view) {
  if (view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    renderBody(view);
    scrollToBottom();
  });
}

function finishBody(view) {
  if (view.frame) { cancelAnimationFrame(view.frame); view.frame = 0; }
  renderBody(view);
  view.body.classList.remove('streaming');
}

function scrollToBottom() {
  const box = $('messages');
  // Only follow the stream when the reader is already at the bottom; yanking
  // the viewport away from someone reading an earlier answer is worse than
  // making them scroll.
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

const TOOL_LABELS = {
  memory_search: 'searching memory',
  memory_graph_explore: 'exploring the memory graph',
  memory_get: 'reading a memory',
  memory_write: 'saving to memory',
  // The plugin's own tool names, so its servers read the same as Core's.
  dai_memory_search: 'searching memory',
  dai_memory_why: 'looking up why',
  dai_memory_get: 'reading a memory',
  dai_memory_write: 'saving to memory',
  dai_memory_neighbors: 'exploring what is connected',
  dai_memory_impact: 'checking what this affects',
  dai_memory_trace: 'tracing through the code',
  dai_memory_context: 'reading context around a symbol',
  dai_memory_constraints: 'checking constraints',
  dai_memory_conflicts: 'looking for contradictions',
};

/**
 * Labels are keyed on the tool, not the server.
 *
 * The server name is the operator's choice -- `memory`, `dai-memory`, anything
 * -- and it is only a prefix. Keying on it would mean a renamed server showed
 * the user raw identifiers.
 */
function toolLabel(name) {
  const bare = name.replace(/^mcp__[\w-]+__/, '');
  return TOOL_LABELS[bare] || bare.replace(/_/g, ' ');
}

async function ask(message) {
  if (state.streaming) return;
  // Any file still being read belongs to this message.
  await stageChain;
  if (state.streaming) return;
  const input = $('input');
  // Taken before the await, and cleared with the textarea: what is on screen
  // after sending should be an empty composer, not the files just sent.
  const attachments = state.attachments;
  state.attachments = [];
  renderAttachments();

  addMessage('user', message, attachments);
  if (!state.conversationId) setChatTitle(message);
  input.value = '';
  input.style.height = 'auto';

  const view = addMessage('assistant');
  const toolNodes = new Map();
  setStreaming(true);

  state.abort = new AbortController();
  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: api.headers({ accept: 'text/event-stream' }),
      body: JSON.stringify({
        conversationId: state.conversationId,
        message,
        attachments: attachments.map(({ name, type, data }) => ({ name, type, data })),
      }),
      signal: state.abort.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`gateway returned ${response.status}`);
    }

    for await (const event of readSse(response.body)) {
      handleEvent(event, view, toolNodes);
    }
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    finishBody(view);
    setStreaming(false);
    state.abort = null;
    void loadConversations();
  }
}

function handleEvent(event, view, toolNodes) {
  switch (event.type) {
    case 'message.delta':
      view.raw += event.text;
      view.body.classList.add('streaming');
      scheduleRender(view);
      break;

    case 'tool.start': {
      view.tools.hidden = false;
      const node = el('div', 'tool running');
      node.append(el('span', 'dot'), el('span', null, toolLabel(event.name)));
      view.tools.append(node);
      toolNodes.set(event.toolId, node);
      scrollToBottom();
      break;
    }

    case 'tool.result': {
      const node = toolNodes.get(event.toolId);
      if (node) {
        node.className = `tool ${event.ok ? 'ok' : 'failed'}`;
        node.lastChild.textContent = event.summary
          ? `${toolLabel(event.name)} — ${event.summary}`
          : toolLabel(event.name);
      }
      break;
    }

    case 'citation':
      view.citations.hidden = false;
      for (const citation of event.citations) {
        state.citations.set(citation.id, citation);
        const chip = el('button', 'citation', citation.id.replace(/^item_/, ''));
        chip.title = citation.snippet;
        chip.addEventListener('click', () => openItem(citation.id));
        view.citations.append(chip);
      }
      scrollToBottom();
      break;

    case 'message.done':
      state.conversationId = event.conversationId;
      if (event.usage) {
        state.spend = {
          costUsd: (state.spend?.costUsd ?? 0) + (event.usage.costUsd ?? 0),
          turns: (state.spend?.turns ?? 0) + 1,
        };
        showSpend();
      }
      break;

    case 'error':
      showError(`${event.message}${event.retryable ? ' (retrying may work)' : ''}`);
      break;
  }
}

function showError(message) {
  clearEmptyState();
  $('messages').append(el('div', 'error', message));
  scrollToBottom();
}

function setStreaming(on) {
  state.streaming = on;
  $('send').disabled = on || state.staging > 0;
  $('cancel').hidden = !on;
  $('attach').disabled = on;
  const hint = document.querySelector('.hint');
  if (hint) {
    hint.textContent = state.staging > 0
      ? `reading ${state.staging === 1 ? 'a file' : 'files'}…`
      : 'Enter to send · Shift+Enter for a newline · drop or paste files';
  }
}

/** Parses an SSE body into events. The `data:` line is the whole payload. */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    // Frames end at a blank line. Splitting on newline alone would hand the
    // parser half a JSON object whenever a chunk lands mid-frame.
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { yield JSON.parse(line.slice(5).trim()); } catch { /* ignore a partial frame */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reads as a data URL, and sends the whole thing.
 *
 * The Gateway strips the `data:...,` prefix itself, so nothing here has to
 * know how to take it off correctly -- and getting that wrong truncates the
 * first bytes of every file, which is the kind of bug that only shows up on
 * binary content.
 */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

/**
 * Reading a file is asynchronous; pressing Enter is not.
 *
 * Found by attaching two files and sending immediately: the larger one had not
 * finished reading, so the message went without it and nothing said so. Every
 * staging run joins this chain, `ask` waits on it, and the send button is
 * disabled while it is not empty -- so the worst case is a send that waits,
 * rather than a file that quietly does not arrive.
 */
let stageChain = Promise.resolve();

function stageFiles(files) {
  state.staging += 1;
  setStreaming(state.streaming);
  stageChain = stageChain
    .then(() => addFiles(files))
    .catch((err) => showError(err.message))
    .finally(() => {
      state.staging -= 1;
      setStreaming(state.streaming);
    });
  return stageChain;
}

async function addFiles(files) {
  const incoming = [...files];
  if (incoming.length === 0) return;

  const staged = state.attachments;
  if (staged.length + incoming.length > ATTACH_LIMITS.count) {
    showError(`You can attach ${ATTACH_LIMITS.count} files to one message.`);
    return;
  }
  const total = staged.reduce((sum, a) => sum + a.size, 0)
    + incoming.reduce((sum, f) => sum + f.size, 0);
  if (total > ATTACH_LIMITS.totalBytes) {
    showError(`That is ${fileSize(total)} of attachments; the limit for one message is `
      + `${fileSize(ATTACH_LIMITS.totalBytes)}.`);
    return;
  }

  for (const file of incoming) {
    try {
      staged.push({
        name: file.name || 'pasted-file',
        type: file.type || 'application/octet-stream',
        size: file.size,
        data: await readAsDataUrl(file),
      });
      renderAttachments();
    } catch (err) {
      showError(err.message);
    }
  }
}

function renderAttachments() {
  const box = $('attachments');
  box.textContent = '';
  box.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    const chip = el('div', 'chip');
    chip.append(
      el('span', 'chip-name', attachment.name),
      el('span', 'chip-size', fileSize(attachment.size)),
    );
    const remove = el('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${attachment.name}`;
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(remove);
    box.append(chip);
  });
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function setChatTitle(text) {
  const title = (text || '').replace(/\s+/g, ' ').trim();
  $('chat-title').textContent = title.length > 70 ? `${title.slice(0, 70)}\u2026` : title || 'New conversation';
}

/**
 * The toggle writes an explicit theme; no explicit theme means follow the OS.
 *
 * Stored per browser rather than per conversation because it is a property of
 * the room you are sitting in, not of the work.
 */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  // The glyph is what the click will do, not what is on screen now.
  $('theme-toggle').textContent = effectiveTheme() === 'dark' ? '\u2600' : '\u263D';
}

function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function toggleSidebar(open) {
  const app = document.getElementById('app');
  const on = open ?? !app.classList.contains('sidebar-open');
  app.classList.toggle('sidebar-open', on);
  $('scrim').hidden = !on;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

async function loadConversations() {
  try {
    const { conversations } = await api.get('/conversations');
    const list = $('conversation-list');
    list.textContent = '';
    for (const conversation of conversations) {
      const node = el('div', `conversation${conversation.id === state.conversationId ? ' active' : ''}`);
      node.append(
        el('span', 'title', conversation.title || '(untitled)'),
        el('span', 'count', String(conversation.turnCount)),
      );
      node.addEventListener('click', () => {
        toggleSidebar(false);
        void openConversation(conversation.id);
      });
      list.append(node);
    }
  } catch (err) {
    $('health-dot').className = 'dot down';
    $('health').textContent = `gateway: ${err.message}`;
  }
}

async function openConversation(id) {
  const conversation = await api.get(`/conversations/${encodeURIComponent(id)}`);
  state.conversationId = id;
  state.spend = conversation.spend ?? null;
  state.costCeiling = conversation.costCeilingUsd ?? 0;
  $('messages').textContent = '';
  for (const message of conversation.messages) {
    addMessage(message.role === 'user' ? 'user' : 'assistant', message.content);
  }
  setChatTitle(conversation.title || conversation.messages.find((m) => m.role === 'user')?.content);
  switchView('chat');
  showSpend();
  void loadConversations();
}

/**
 * Keeps the running cost in front of the person spending it.
 *
 * In the status bar rather than behind a menu: the failure this exists for is
 * not knowing a conversation was expensive until the quota is gone.
 */
function showSpend() {
  if (!state.spend || state.spend.costUsd <= 0) return;
  const ceiling = state.costCeiling > 0 ? ` / $${state.costCeiling.toFixed(2)}` : '';
  const node = $('health');
  node.textContent = `$${state.spend.costUsd.toFixed(4)}${ceiling} · ${state.spend.turns} turns`;
  node.style.color = state.costCeiling > 0 && state.spend.costUsd > state.costCeiling * 0.8
    ? 'var(--warn)' : '';
}

// ---------------------------------------------------------------------------
// Memory explorer
// ---------------------------------------------------------------------------

async function loadMemory() {
  const query = $('memory-query').value.trim();
  const type = $('memory-type').value;
  const superseded = $('memory-superseded').checked;
  const list = $('memory-list');
  const fusion = $('fusion-report');

  try {
    if (query) {
      // Searching goes through retrieval, so the explorer shows exactly what
      // the model would have seen -- including the fusion report, which is the
      // single most useful thing in this UI when recall goes wrong.
      const result = await api.send('POST', '/memory/search', {
        query, limit: 30, maxTokens: 4000,
        types: type ? [type] : undefined,
        includeSuperseded: superseded,
      });
      renderFusion(fusion, result);
      list.textContent = '';
      for (const citation of result.citations) {
        list.append(memoryCard({
          id: citation.id, type: citation.type, content: citation.snippet,
          source: citation.source, createdAt: citation.timestamp, supersededBy: null,
        }, citation));
      }
      if (result.citations.length === 0) list.append(el('p', 'empty', 'Nothing matched.'));
    } else {
      fusion.hidden = true;
      const params = new URLSearchParams({ limit: '100' });
      if (type) params.set('types', type);
      if (superseded) params.set('includeSuperseded', 'true');
      const { items, total } = await api.get(`/memory/items?${params}`);
      list.textContent = '';
      list.append(el('p', 'fusion', `${items.length} of ${total} memories`));
      for (const item of items) list.append(memoryCard(item));
      if (items.length === 0) list.append(el('p', 'empty', 'No memories yet.'));
    }
  } catch (err) {
    list.textContent = '';
    list.append(el('div', 'error', err.message));
  }
}

function renderFusion(node, result) {
  node.hidden = false;
  node.textContent = '';
  node.append(el('div', null,
    `branches: ${Object.entries(result.fusion.branches).map(([k, v]) => `${k}=${v}`).join('  ')}`
    + `   ·   ${result.total} matched, ${result.omitted} omitted`
    + `   ·   ${result.tokens.used}/${result.tokens.budget} tokens   ·   ${result.tookMs}ms`));
  for (const name of result.fusion.degraded) {
    node.append(el('div', 'degraded', `⚠ ${name}: ${result.fusion.reasons[name] || ''}`));
  }
}

function memoryCard(item, citation) {
  const card = el('div', `item${item.supersededBy ? ' superseded' : ''}`);
  const meta = el('div', 'meta');
  meta.append(el('span', `badge ${item.type}`, item.type));
  meta.append(el('span', null, item.id.replace(/^item_/, '')));
  meta.append(el('span', null, String(item.createdAt).slice(0, 10)));
  if (item.source) meta.append(el('span', null, item.source));
  if (citation?.ranks && Object.keys(citation.ranks).length) {
    meta.append(el('span', null, `ranks ${Object.entries(citation.ranks).map(([b, r]) => `${b}#${r}`).join(' ')}`));
  }
  if (item.supersededBy) meta.append(el('span', 'badge', 'superseded'));
  card.append(meta, el('div', 'content', item.content));
  card.addEventListener('click', () => openItem(item.id));
  return card;
}

async function openItem(id) {
  const panel = $('detail');
  const body = $('detail-body');
  panel.hidden = false;
  document.getElementById('app').classList.add('with-detail');
  $('detail-title').textContent = id.replace(/^item_/, '');
  body.textContent = 'Loading…';

  try {
    const item = await api.get(`/memory/items/${encodeURIComponent(id)}`);
    body.textContent = '';

    for (const [label, value] of [
      ['type', item.type],
      ['source', item.source],
      ['created', item.createdAt],
      ['updated', item.updatedAt],
      ['confidence', String(item.confidence)],
      ['conversation', item.conversationId || '(written directly)'],
      ['superseded by', item.supersededBy || '—'],
    ]) {
      const field = el('div', 'field');
      field.append(el('div', 'label', label), el('div', 'value', value));
      body.append(field);
    }

    const editor = el('textarea');
    editor.value = item.content;
    body.append(el('div', 'label', 'content'), editor);

    const actions = el('div', 'detail-actions');
    const save = el('button', null, 'Save');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api.send('PATCH', `/memory/items/${encodeURIComponent(id)}`, { content: editor.value });
        save.textContent = 'Saved';
        void loadMemory();
      } catch (err) {
        save.textContent = err.message;
      } finally {
        setTimeout(() => { save.textContent = 'Save'; save.disabled = false; }, 1600);
      }
    });

    const remove = el('button', 'danger', 'Delete');
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete ${id}? This cannot be undone.`)) return;
      await api.send('DELETE', `/memory/items/${encodeURIComponent(id)}`);
      closeDetail();
      void loadMemory();
    });

    actions.append(save, remove);
    body.append(actions);
    await appendNeighbors(body, item);
  } catch (err) {
    body.textContent = '';
    body.append(el('div', 'error', err.message));
  }
}

/**
 * Shows the graph around the first entity this memory mentions.
 *
 * "Why did retrieval find this?" is usually answered by what it is connected
 * to, so the explorer shows the neighbourhood rather than making you leave for
 * a different view.
 */
async function appendNeighbors(body, item) {
  const guess = item.content.match(/\b([A-Z][\w]+(?: [A-Z][\w]+)?)\b/);
  if (!guess) return;
  try {
    const graph = await api.get(`/memory/entities/${encodeURIComponent(guess[1])}/graph?depth=1`);
    if (!graph.root) return;
    body.append(el('div', 'label', `graph around "${graph.root.name}"`));
    for (const entity of graph.entities) {
      if (entity.id === graph.root.id) continue;
      const node = el('div', 'neighbor', entity.name);
      node.addEventListener('click', () => {
        $('memory-query').value = entity.name;
        switchView('memory');
        void loadMemory();
      });
      body.append(node);
    }
  } catch { /* neighbours are a bonus; their absence is not an error */ }
}

function closeDetail() {
  $('detail').hidden = true;
  document.getElementById('app').classList.remove('with-detail');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function switchView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
  $('view-chat').classList.toggle('active', name === 'chat');
  $('view-memory').classList.toggle('active', name === 'memory');
  if (name === 'memory') void loadMemory();
}

function init() {
  applyTheme(localStorage.getItem(THEME_KEY));
  $('theme-toggle').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  for (const button of document.querySelectorAll('#sidebar-toggle, .sidebar-toggle')) {
    button.addEventListener('click', () => toggleSidebar());
  }
  $('scrim').addEventListener('click', () => toggleSidebar(false));

  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = $('input').value.trim();
    if (message) void ask(message);
  });

  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('input').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
  });

  $('cancel').addEventListener('click', () => state.abort?.abort());

  // --- attaching ---
  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => {
    await stageFiles(event.target.files);
    // Cleared so choosing the same file twice in a row still fires `change`.
    event.target.value = '';
  });

  $('input').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    // Only when the clipboard carries a file. Pasting text that happens to sit
    // beside an image on the clipboard should still paste the text.
    event.preventDefault();
    void stageFiles(files);
  });

  const box = $('composer-box');
  let dragDepth = 0;
  // Counted, not toggled: dragging over a child fires leave on the parent, and
  // a boolean flickers the hint off every time the pointer crosses the textarea.
  box.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    $('drop-hint').hidden = false;
  });
  box.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault();
  });
  box.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('drop-hint').hidden = true;
  });
  box.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    void stageFiles(event.dataTransfer.files);
  });

  // A file dropped anywhere else would otherwise replace the page with it.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (event) => {
      if (!box.contains(event.target)) event.preventDefault();
    });
  }

  $('new-chat').addEventListener('click', () => {
    state.conversationId = null;
    state.spend = null;
    $('messages').textContent = '';
    const empty = el('div', 'empty');
    empty.append(
      el('div', 'empty-logo', '\u{1F9E0}'),
      el('h2', null, 'What can I help you with?'),
      el('p', null, 'Answers are grounded in what you have told DAI Brain before.'),
    );
    $('messages').append(empty);
    state.attachments = [];
    renderAttachments();
    setChatTitle(null);
    toggleSidebar(false);
    switchView('chat');
    void loadConversations();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  $('memory-refresh').addEventListener('click', () => void loadMemory());
  $('memory-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') void loadMemory(); });
  $('memory-type').addEventListener('change', () => void loadMemory());
  $('memory-superseded').addEventListener('change', () => void loadMemory());
  $('detail-close').addEventListener('click', closeDetail);

  void checkHealth();
  void loadConversations();
}

async function checkHealth() {
  try {
    const health = await api.get('/health');
    $('health-dot').className = 'dot up';
    $('health').textContent =
      `${health.runner} · ${health.concurrency.available}/${health.concurrency.limit} free`
      + (health.store ? ` · ${health.store}` : '')
      + (health.auth.startsWith('DEV') ? ' · dev auth' : '');

    // Without Core there is nothing for the explorer to read, so the tab is
    // removed rather than left to fail when clicked.
    if (health.memoryExplorer === false) {
      document.querySelector('.tab[data-view="memory"]')?.remove();
      // One tab is not a choice; the bar is just a wide button at that point.
      document.querySelector('.tabs').hidden = true;
      switchView('chat');
      // Citations come from Brain Core's packer. Without it the answer is
      // still grounded in memory, just not traceable line by line, and the
      // greeting should not promise otherwise.
      const promise = document.querySelector('.empty p');
      if (promise) promise.textContent = 'Answers are grounded in what you have told DAI Brain before.';
    }
  } catch (err) {
    $('health-dot').className = 'dot down';
    $('health').textContent = `offline: ${err.message}`;
  }
}

init();
