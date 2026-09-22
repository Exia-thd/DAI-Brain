import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt, scopeFor } from '../gateway/dist/index.js';

const SECRET = 'test-secret-value';

test('a signed token verifies and carries its claims', () => {
  const token = signJwt({ sub: 'thd', tenant: 'acme', projects: ['brain'] }, SECRET);
  const claims = verifyJwt(token, SECRET);
  assert.equal(claims.sub, 'thd');
  assert.equal(claims.tenant, 'acme');
  assert.deepEqual(claims.projects, ['brain']);
});

test('a token signed with another secret is refused', () => {
  const token = signJwt({ sub: 'thd', tenant: 'acme' }, 'other-secret');
  assert.throws(() => verifyJwt(token, SECRET), /signature does not verify/);
});

test('alg: none is refused', () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'attacker', tenant: 'acme' })}.`;
  assert.throws(() => verifyJwt(forged, SECRET), /unsupported token algorithm/);
});

test('a tampered payload is refused', () => {
  const token = signJwt({ sub: 'thd', tenant: 'acme' }, SECRET);
  const [header, , signature] = token.split('.');
  const swapped = Buffer.from(JSON.stringify({ sub: 'someone-else', tenant: 'acme' })).toString('base64url');
  assert.throws(() => verifyJwt(`${header}.${swapped}.${signature}`, SECRET), /signature does not verify/);
});

test('an expired token is refused', () => {
  const token = signJwt({ sub: 'thd', tenant: 'acme' }, SECRET, -10);
  assert.throws(() => verifyJwt(token, SECRET), /expired/);
});

test('malformed tokens are refused rather than accepted as empty', () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '....']) {
    assert.throws(() => verifyJwt(bad, SECRET));
  }
});

test('a token cannot reach a project it was not granted', () => {
  const claims = { sub: 'thd', tenant: 'acme', projects: ['brain'] };
  assert.equal(scopeFor(claims, 'brain').project, 'brain');
  assert.throws(() => scopeFor(claims, 'someone-elses-project'), /does not grant project/);
});

test('a wildcard token reads across its own projects and no further', () => {
  const claims = { sub: 'thd', tenant: 'acme', projects: ['*'] };
  assert.equal(scopeFor(claims, undefined).project, null);
  assert.equal(scopeFor(claims, 'anything').project, 'anything');
  // The tenant and user still come from the token, never from the request.
  assert.equal(scopeFor(claims, 'anything').tenant, 'acme');
  assert.equal(scopeFor(claims, 'anything').user, 'thd');
});

test('a token granting no projects cannot produce a scope', () => {
  assert.throws(() => scopeFor({ sub: 'thd', tenant: 'acme', projects: [] }, undefined), /grants no projects/);
});
