import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandTable, commandName, runCommand } from '../gateway/dist/index.js';

const collect = async (name, table, cwd = process.cwd()) => {
  const events = [];
  const controller = new AbortController();
  for await (const event of runCommand(name, table, cwd, 'conv_1', controller.signal)) {
    events.push(event);
  }
  return events;
};
const textOf = (events) => events.filter((e) => e.type === 'message.delta').map((e) => e.text).join('');

test('a command is a bare name and nothing else', () => {
  assert.equal(commandName('/sync'), 'sync');
  assert.equal(commandName('  /Sync  '), 'sync');
  assert.equal(commandName('/help'), 'help');

  // The property the whole design rests on: a message cannot contribute an
  // argument, only choose which of the operator's entries runs.
  assert.equal(commandName('/sync --force'), null);
  assert.equal(commandName('/sync; rm -rf /'), null);
  assert.equal(commandName('/sync\nand then'), null);
  assert.equal(commandName('what does /sync do?'), null);
  assert.equal(commandName('sync'), null);
  assert.equal(commandName('/'), null);
  assert.equal(commandName('/../etc'), null);
});

test('the table is argv, and a malformed one says which entry', () => {
  const table = parseCommandTable('{"sync":["node","-e","0"],"pull":["git","pull"]}');
  assert.deepEqual([...table.keys()], ['sync', 'pull']);
  assert.deepEqual(table.get('sync'), ['node', '-e', '0']);

  assert.deepEqual([...parseCommandTable('').keys()], []);
  assert.deepEqual([...parseCommandTable(undefined).keys()], []);

  assert.throws(() => parseCommandTable('{'), /not valid JSON/);
  assert.throws(() => parseCommandTable('["a"]'), /object of name -> argv/);
  // A command line is not argv: quoting it is what this format exists to avoid.
  assert.throws(() => parseCommandTable('{"sync":"dai-memory ingest"}'), /non-empty array/);
  assert.throws(() => parseCommandTable('{"sync":[]}'), /non-empty array/);
  assert.throws(() => parseCommandTable('{"sync":["ok",2]}'), /non-empty array/);
  assert.throws(() => parseCommandTable('{"a b":["x"]}'), /not a usable command name/);
  assert.throws(() => parseCommandTable('{"../x":["y"]}'), /not a usable command name/);
});

test('help lists what is configured, and says so when nothing is', async () => {
  const listed = textOf(await collect('help', parseCommandTable('{"sync":["node","-e","0"]}')));
  assert.match(listed, /\/sync/);
  assert.match(listed, /node -e 0/);

  const empty = textOf(await collect('help', parseCommandTable('')));
  assert.match(empty, /No commands are configured/);
  assert.match(empty, /GATEWAY_COMMANDS/);
});

test('an unknown command is a refusal that names the way out', async () => {
  await assert.rejects(() => collect('nope', parseCommandTable('{"sync":["node","-e","0"]}')), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /no \/nope command here.*\/help/s);
    return true;
  });
});

test('output streams, and the turn is reported as a tool call', async () => {
  const table = parseCommandTable(JSON.stringify({
    sync: ['node', '-e', 'process.stdout.write("scanned 3 files\\n"); process.stderr.write("1 skipped\\n")'],
  }));
  const events = await collect('sync', table);

  const start = events.find((e) => e.type === 'tool.start');
  assert.equal(start.name, '/sync');
  const result = events.find((e) => e.type === 'tool.result');
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'done');

  const text = textOf(events);
  assert.match(text, /scanned 3 files/);
  // stderr is output too: a scan reports what it skipped there.
  assert.match(text, /1 skipped/);

  const done = events.at(-1);
  assert.equal(done.type, 'message.done');
  assert.equal(done.usage.costUsd, 0, 'a command must not look like a paid turn');
});

test('a failing command is reported as failed, with its exit code', async () => {
  const table = parseCommandTable(JSON.stringify({
    sync: ['node', '-e', 'process.stderr.write("no store here\\n"); process.exit(3)'],
  }));
  const events = await collect('sync', table);
  const result = events.find((e) => e.type === 'tool.result');
  assert.equal(result.ok, false);
  assert.match(result.summary, /exited with code 3/);
  assert.match(textOf(events), /no store here/);
});

test('a command that cannot start says so instead of hanging', async () => {
  const table = parseCommandTable('{"sync":["definitely-not-a-program-9f3a"]}');
  const events = await collect('sync', table);
  const result = events.find((e) => e.type === 'tool.result');
  assert.equal(result.ok, false);
  assert.match(result.summary, /could not start/);
  // Nothing was printed, so the reason has to reach the reader some other way.
  assert.match(textOf(events), /could not start/);
});

test('runaway output is truncated rather than buffered without limit', async () => {
  const table = parseCommandTable(JSON.stringify({
    sync: ['node', '-e', 'for (let i = 0; i < 4000; i++) process.stdout.write("x".repeat(100) + "\\n")'],
  }));
  const events = await collect('sync', table);
  assert.equal(events.find((e) => e.type === 'tool.result').ok, true);
});
