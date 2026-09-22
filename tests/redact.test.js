import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, looksSecret } from '../core/dist/index.js';

test('provider API keys reject the whole item', () => {
  for (const secret of [
    'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghijkl',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  ]) {
    const result = redact(`the token is ${secret}`);
    assert.equal(result.rejected, true, `${secret} should be rejected`);
    assert.ok(result.rejectedBy);
    assert.equal(looksSecret(`x ${secret}`), true);
  }
});

test('assignment-shaped secrets keep the name and lose the value', () => {
  const result = redact('Set DB_PASSWORD=hunter2hunter2 in the env file.');
  assert.equal(result.rejected, false);
  assert.match(result.text, /DB_PASSWORD=\[redacted\]/);
  assert.doesNotMatch(result.text, /hunter2/);
});

test('a database URL loses its password and keeps its shape', () => {
  const result = redact('connect to postgres://admin:s3cr3tpass@db.internal:5432/app');
  assert.doesNotMatch(result.text, /s3cr3tpass/);
  assert.match(result.text, /postgres:\/\/admin:\[redacted\]@/);
});

test('emails are masked', () => {
  assert.match(redact('mail me at someone@example.com').text, /\[email\]/);
});

test('the card rule only fires on numbers that pass Luhn', () => {
  // A real test card number.
  assert.match(redact('card 4111111111111111').text, /\[card\]/);
  // A version string and a timestamp are digits too; masking them would make
  // the filter destroy ordinary memories.
  const benign = redact('build 20240115123456789 finished');
  assert.match(benign.text, /20240115123456789/);
});

test('ordinary text is returned unchanged', () => {
  const text = 'We chose PostgreSQL over Neo4j because the graph is small.';
  const result = redact(text);
  assert.equal(result.text, text);
  assert.equal(result.rejected, false);
  assert.deepEqual(result.hits, []);
});

test('the global regexes do not carry state between calls', () => {
  // Every rule is a module-level global regex; a forgotten lastIndex reset
  // would make the second call miss what the first one caught.
  const input = 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  assert.equal(redact(input).rejected, true);
  assert.equal(redact(input).rejected, true);
  assert.equal(redact(input).rejected, true);
});
