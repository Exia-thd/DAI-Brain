import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScope, parseWriteScope, parseScopeHeader, formatScopeHeader,
  scopeContains, sameScope,
} from '../shared/dist/index.js';

test('a scope requires tenant and user', () => {
  assert.throws(() => parseScope({}), /tenant is required/);
  assert.throws(() => parseScope({ tenant: 'a' }), /user is required/);
  assert.deepEqual(parseScope({ tenant: 'a', user: 'b' }), { tenant: 'a', user: 'b', project: null });
});

test('a write requires a project', () => {
  assert.throws(() => parseWriteScope({ tenant: 'a', user: 'b' }), /project is required for writes/);
  assert.equal(parseWriteScope({ tenant: 'a', user: 'b', project: 'c' }).project, 'c');
});

test('segments that would break the header encoding are refused', () => {
  // The whole point of the character class: `a/b` in a segment would make two
  // different scopes serialise to the same header.
  assert.throws(() => parseScope({ tenant: 'a/b', user: 'c', project: 'd' }), /must match/);
  assert.throws(() => parseScope({ tenant: 'a', user: '', project: 'd' }), /required/);
  assert.throws(() => parseScope({ tenant: '../etc', user: 'c', project: 'd' }), /must match/);
});

test('the header round-trips, including the wildcard project', () => {
  for (const scope of [
    { tenant: 'acme', user: 'thd', project: 'brain' },
    { tenant: 'acme', user: 'thd', project: null },
  ]) {
    assert.deepEqual(parseScopeHeader(formatScopeHeader(scope)), scope);
  }
});

test('a malformed header is refused rather than defaulted', () => {
  assert.throws(() => parseScopeHeader(undefined), /required/);
  assert.throws(() => parseScopeHeader('acme/thd'), /tenant\/user\/project/);
  assert.throws(() => parseScopeHeader('a/b/c/d'), /tenant\/user\/project/);
});

test('containment never crosses a user or a tenant', () => {
  const wildcard = { tenant: 'acme', user: 'thd', project: null };
  const pinned = { tenant: 'acme', user: 'thd', project: 'brain' };
  assert.equal(scopeContains(wildcard, pinned), true);
  assert.equal(scopeContains(pinned, wildcard), false);
  assert.equal(scopeContains(wildcard, { ...pinned, user: 'someone-else' }), false);
  assert.equal(scopeContains(wildcard, { ...pinned, tenant: 'other' }), false);
  assert.equal(sameScope(pinned, { ...pinned }), true);
});
