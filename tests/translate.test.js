import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamTranslator, parseCitations } from '../gateway/dist/index.js';

const collect = (lines, conversationId = 'conv_1') => {
  const translator = new StreamTranslator(conversationId);
  const events = [];
  for (const line of lines) events.push(...translator.translate(line));
  return { events, translator };
};

test('streamed text deltas become message.delta and accumulate', () => {
  const { events, translator } = collect([
    { type: 'system', subtype: 'init', session_id: 'sess_abc' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['message.delta', 'message.delta']);
  assert.equal(translator.text, 'Hello world');
  assert.equal(translator.claudeSessionId, 'sess_abc');
});

test('a tool use becomes tool.start and its result is labelled with the name', () => {
  const { events } = collect([
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__memory__memory_search', input: { query: 'x' } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'No memory matched "x".' }] } },
  ]);
  assert.equal(events[0].type, 'tool.start');
  assert.equal(events[0].name, 'mcp__memory__memory_search');
  assert.equal(events[1].type, 'tool.result');
  // The name arrived on a different line than the result; pairing them is the
  // whole reason this translator is stateful.
  assert.equal(events[1].name, 'mcp__memory__memory_search');
  assert.equal(events[1].ok, true);
  assert.match(events[1].summary, /no memories matched/);
});

test('a memory search result produces citations', () => {
  const toolText = [
    'Relevant memory from DAI Brain. Cite an item by its id when you use it.',
    '',
    '[item_abc123] (decision, 2026-01-15, src=conversation:conv_9)',
    'We chose PostgreSQL over Neo4j.',
    '',
    '[item_def456] (fact, 2026-02-01, src=seed)',
    'The latency target is 500ms.',
    '',
    '---',
    '2 item(s) matched, 2 returned, 0 omitted for budget.',
  ].join('\n');

  const { events } = collect([
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__memory__memory_search' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: toolText }] } },
  ]);
  const citation = events.find((e) => e.type === 'citation');
  assert.ok(citation, 'a memory search must produce a citation event');
  assert.equal(citation.citations.length, 2);
  assert.equal(citation.citations[0].id, 'item_abc123');
  assert.equal(citation.citations[0].type, 'decision');
  assert.equal(citation.citations[0].source, 'conversation:conv_9');
  assert.match(citation.citations[0].snippet, /PostgreSQL/);
  const result = events.find((e) => e.type === 'tool.result');
  assert.match(result.summary, /found 2 memories/);
});

test('a non-memory tool produces no citations', () => {
  const { events } = collect([
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_2', name: 'Bash' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '[item_x] (note, 2026-01-01, src=s)\nnot a memory' }] } },
  ]);
  assert.ok(!events.some((e) => e.type === 'citation'));
});

test('a failed tool result is reported as failed', () => {
  const { events } = collect([
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_3', name: 'mcp__memory__memory_get' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3', is_error: true, content: 'no item item_zzz in this scope' }] } },
  ]);
  const result = events.find((e) => e.type === 'tool.result');
  assert.equal(result.ok, false);
  assert.ok(!events.some((e) => e.type === 'citation'));
});

test('the final result yields message.done with usage', () => {
  const { events } = collect([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    { type: 'result', subtype: 'success', session_id: 'sess_z', result: 'answer', total_cost_usd: 0.0123, usage: { input_tokens: 500, output_tokens: 42 } },
  ]);
  const done = events.at(-1);
  assert.equal(done.type, 'message.done');
  assert.equal(done.conversationId, 'conv_1');
  assert.equal(done.sessionId, 'sess_z');
  assert.equal(done.usage.outputTokens, 42);
  assert.equal(done.usage.costUsd, 0.0123);
});

test('non-streaming output is not emitted twice', () => {
  // `result.result` repeats the whole answer. Taking it after deltas already
  // carried the text would show the user the answer twice.
  const { events } = collect([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the answer' } },
    { type: 'result', result: 'the answer' },
  ]);
  const deltas = events.filter((e) => e.type === 'message.delta');
  assert.equal(deltas.length, 1);
});

test('a result with no preceding deltas still delivers the answer', () => {
  const { events, translator } = collect([{ type: 'result', result: 'the whole answer' }]);
  assert.equal(events[0].type, 'message.delta');
  assert.equal(translator.text, 'the whole answer');
});

test('whole assistant messages are handled as well as deltas', () => {
  const { events, translator } = collect([
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'Considering that, ' },
      { type: 'tool_use', id: 'tu_9', name: 'mcp__memory__memory_write', input: {} },
    ], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);
  assert.equal(events[0].type, 'message.delta');
  assert.equal(events[1].type, 'tool.start');
  assert.equal(translator.text, 'Considering that, ');
});

test('an errored result becomes an error event', () => {
  const { events } = collect([{ type: 'result', is_error: true, result: 'rate limited' }]);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].code, 'runner_failed');
});

test('unknown line types are ignored rather than fatal', () => {
  // The CLI's output shape is not a frozen contract; throwing on an unfamiliar
  // line would turn a CLI upgrade into an outage.
  const { events } = collect([
    { type: 'something_new_in_a_later_cli', payload: { nested: true } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    {},
  ]);
  assert.deepEqual(events, []);
});

test('parseCitations tolerates text that is not a memory block', () => {
  assert.deepEqual(parseCitations('just some prose'), []);
  assert.deepEqual(parseCitations(''), []);
});

// ---------------------------------------------------------------------------
// The init line
// ---------------------------------------------------------------------------

const INIT = (extra) => ({ type: 'system', subtype: 'init', session_id: 'sess_1', ...extra });

test('a connected memory server is reported as nothing at all', () => {
  const { events, translator } = collect([INIT({
    mcp_servers: [{ name: 'dai-memory', status: 'connected' }],
    tools: ['Read', 'mcp__dai-memory__dai_memory_search', 'mcp__dai-memory__dai_memory_map'],
  })]);
  assert.deepEqual(events, []);
  assert.deepEqual([...translator.memoryTools], [
    'mcp__dai-memory__dai_memory_search',
    'mcp__dai-memory__dai_memory_map',
  ]);
});

test('a memory server that did not connect says so, instead of answering from nothing', () => {
  // The whole failure this exists for: the server dies at startup, every tool
  // call is refused, and without this the only sign is a vaguer answer.
  const { events } = collect([INIT({
    mcp_servers: [{ name: 'dai-memory', status: 'failed' }],
    tools: ['Read'],
  })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /dai-memory MCP server did not connect \(failed\)/);
  assert.match(events[0].message, /not grounded in memory/);
});

test('a server that is up but exposes no memory tools is its own failure', () => {
  // An allow list that names tools the server does not have looks exactly like
  // an empty memory store from the outside.
  const { events } = collect([INIT({
    mcp_servers: [{ name: 'dai-memory', status: 'connected' }],
    tools: ['Read', 'Glob'],
  })]);
  assert.equal(events.length, 1);
  assert.match(events[0].message, /no memory tools/);
  assert.match(events[0].message, /dai-memory/);
});

test('both memory server naming conventions are recognised', () => {
  const { translator } = collect([INIT({
    mcp_servers: [{ name: 'memory', status: 'connected' }],
    tools: ['mcp__memory__memory_search', 'mcp__dai-memory__dai_memory_why', 'mcp__jira__search'],
  })]);
  assert.deepEqual([...translator.memoryTools],
    ['mcp__memory__memory_search', 'mcp__dai-memory__dai_memory_why']);
});

test('no MCP servers configured is a setup, not a fault', () => {
  const { events } = collect([INIT({ mcp_servers: [], tools: ['Read'] })]);
  assert.deepEqual(events, []);
});

test('init is read once, so a resumed session does not repeat the warning', () => {
  const failing = INIT({ mcp_servers: [{ name: 'dai-memory', status: 'failed' }], tools: [] });
  const { events } = collect([failing, failing]);
  assert.equal(events.length, 1);
});

test('a system line that is not init is still ignored', () => {
  const { events } = collect([{ type: 'system', subtype: 'compact_boundary' }]);
  assert.deepEqual(events, []);
});
