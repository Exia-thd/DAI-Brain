import { createHmac, timingSafeEqual } from 'node:crypto';
import { forbidden, parseScope, unauthorized, type Scope } from '@dai-brain/shared';

/**
 * HS256 verification, hand-rolled.
 *
 * A JWT library would be fine; this is thirty lines and removes a dependency
 * from the one component that sits between the internet and every user's
 * memory. What matters is what it refuses: an unsigned token, a token signed
 * with `alg: none`, an expired one, and one whose claims do not name a scope.
 */

export interface Claims {
  sub: string;
  tenant: string;
  /** Projects this token may read. `['*']` means every project of this user. */
  projects?: string[];
  exp?: number;
  nbf?: number;
  iat?: number;
}

function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signJwt(claims: Claims, secret: string, ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims })));
  const signature = b64urlEncode(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('malformed token');
  const [header, payload, signature] = parts as [string, string, string];

  let alg: string;
  try {
    alg = (JSON.parse(b64urlDecode(header).toString('utf8')) as { alg?: string }).alg ?? '';
  } catch {
    throw unauthorized('malformed token header');
  }
  // `alg: none` is the classic forgery: a token with an empty signature that a
  // naive verifier accepts because it never checked what it was verifying.
  if (alg !== 'HS256') throw unauthorized(`unsupported token algorithm ${alg || '(none)'}`);

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = b64urlDecode(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw unauthorized('token signature does not verify');
  }

  let claims: Claims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as Claims;
  } catch {
    throw unauthorized('malformed token payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now) throw unauthorized('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now) throw unauthorized('token not yet valid');
  if (!claims.sub || !claims.tenant) throw unauthorized('token must carry sub and tenant');
  return claims;
}

/**
 * Turns verified claims plus a requested project into the scope Core will see.
 *
 * This function is the security boundary of the whole system. The project comes
 * from the request body -- which is to say, from the browser -- so it is checked
 * against the token's allowlist here and nowhere else. Downstream, Core trusts
 * the X-Scope header completely, and that trust is only earned because this
 * check happened first.
 */
export function scopeFor(claims: Claims, requestedProject: string | undefined): Scope {
  const allowed = claims.projects ?? ['*'];
  const wildcard = allowed.includes('*');

  if (!requestedProject) {
    // With no project named, a wildcard token reads across all of its projects
    // and a restricted one falls back to its first. Neither invents access.
    const project = wildcard ? null : (allowed[0] ?? null);
    if (!wildcard && project === null) throw forbidden('token grants no projects');
    return parseScope({ tenant: claims.tenant, user: claims.sub, project });
  }

  if (!wildcard && !allowed.includes(requestedProject)) {
    throw forbidden(`token does not grant project ${requestedProject}`);
  }
  return parseScope({ tenant: claims.tenant, user: claims.sub, project: requestedProject });
}
