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
};

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

function addMessage(role, text = '') {
  clearEmptyState();
  const wrap = el('div', `msg ${role}`);
  wrap.append(el('div', 'role', role === 'user' ? 'You' : 'DAI Brain'));
  const tools = el('div', 'tools');
  tools.hidden = true;
  const body = el('div', 'body', text);
  const citations = el('div', 'citations');
  citations.hidden = true;
  wrap.append(tools, body, citations);
  $('messages').append(wrap);
  scrollToBottom();
  return { wrap, tools, body, citations };
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
  mcp__memory__memory_search: 'searching memory',
  mcp__memory__memory_graph_explore: 'exploring the memory graph',
  mcp__memory__memory_get: 'reading a memory',
  mcp__memory__memory_write: 'saving to memory',
};

function toolLabel(name) {
  return TOOL_LABELS[name] || name.replace(/^mcp__\w+__/, '').replace(/_/g, ' ');
}

async function ask(message) {
  if (state.streaming) return;
  const input = $('input');
  addMessage('user', message);
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
      body: JSON.stringify({ conversationId: state.conversationId, message }),
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
    setStreaming(false);
    state.abort = null;
    void loadConversations();
  }
}

function handleEvent(event, view, toolNodes) {
  switch (event.type) {
    case 'message.delta':
      view.body.textContent += event.text;
      scrollToBottom();
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
        node.lastChild.textContent = `${toolLabel(event.name)} — ${event.summary}`;
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
        const cost = event.usage.costUsd != null ? `, $${event.usage.costUsd.toFixed(4)}` : '';
        $('health').textContent =
          `${event.usage.inputTokens} in / ${event.usage.outputTokens} out${cost}`;
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
  $('send').disabled = on;
  $('cancel').hidden = !on;
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
      node.addEventListener('click', () => openConversation(conversation.id));
      list.append(node);
    }
  } catch (err) {
    $('health').textContent = `gateway: ${err.message}`;
  }
}

async function openConversation(id) {
  const conversation = await api.get(`/conversations/${encodeURIComponent(id)}`);
  state.conversationId = id;
  $('messages').textContent = '';
  for (const message of conversation.messages) {
    addMessage(message.role === 'user' ? 'user' : 'assistant', message.content);
  }
  void loadConversations();
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

  $('new-chat').addEventListener('click', () => {
    state.conversationId = null;
    $('messages').textContent = '';
    const empty = el('div', 'empty');
    empty.append(el('h2', null, 'Ask anything'), el('p', null,
      'Answers are grounded in what you have told DAI Brain before.'));
    $('messages').append(empty);
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
    $('health').textContent =
      `${health.runner} · ${health.concurrency.available}/${health.concurrency.limit} free`
      + (health.auth.startsWith('DEV') ? ' · dev auth' : '');
  } catch (err) {
    $('health').textContent = `offline: ${err.message}`;
  }
}

init();
