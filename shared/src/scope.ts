/**
 * The scope model: `tenant -> user -> project`.
 *
 * Every read and every write carries one, and a scope never comes from a model.
 * This file is the only place that decides what a scope is, because the rule it
 * enforces -- one user cannot see another user's memory -- has exactly one way
 * to fail, and that is a query built without one.
 */

export interface Scope {
  tenant: string;
  user: string;
  /** Null means "all projects this user has", used by cross-project recall. */
  project: string | null;
}

/** A scope with the project pinned. Writes require one; reads do not. */
export interface WriteScope extends Scope {
  project: string;
}

export class ScopeError extends Error {
  override readonly name = 'ScopeError';
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/**
 * Segments are validated rather than escaped.
 *
 * Every query in Core is parameterised, so a strange segment could not reach
 * SQL as code even if it tried. The reason to validate anyway is the header
 * wire format below: `X-Scope` joins segments with `/`, and a segment that may
 * contain `/` makes `tenant=a, user=b/c` and `tenant=a/b, user=c` the same
 * string. Two scopes that serialise identically are a cross-tenant read waiting
 * to happen, so the character class exists to keep the encoding injective.
 */
function segment(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScopeError(`scope.${field} is required`);
  }
  if (!SEGMENT.test(value)) {
    throw new ScopeError(
      `scope.${field} must match ${SEGMENT.source} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

export function parseScope(input: unknown): Scope {
  if (typeof input !== 'object' || input === null) {
    throw new ScopeError('scope is required');
  }
  const raw = input as Record<string, unknown>;
  const project = raw.project == null || raw.project === '' ? null : segment(raw.project, 'project');
  return {
    tenant: segment(raw.tenant, 'tenant'),
    user: segment(raw.user, 'user'),
    project,
  };
}

export function parseWriteScope(input: unknown): WriteScope {
  const scope = parseScope(input);
  if (scope.project === null) {
    throw new ScopeError('scope.project is required for writes');
  }
  return scope as WriteScope;
}

/** Wire format for the `X-Scope` header the Gateway sets and Core trusts. */
export const SCOPE_HEADER = 'x-scope';

export function formatScopeHeader(scope: Scope): string {
  return [scope.tenant, scope.user, scope.project ?? '*'].join('/');
}

export function parseScopeHeader(value: string | undefined | null): Scope {
  if (!value) throw new ScopeError(`${SCOPE_HEADER} header is required`);
  const parts = value.split('/');
  if (parts.length !== 3) {
    throw new ScopeError(`${SCOPE_HEADER} must be tenant/user/project (got ${JSON.stringify(value)})`);
  }
  const [tenant, user, project] = parts;
  return parseScope({ tenant, user, project: project === '*' ? null : project });
}

/** True when `inner` is fully contained by `outer`. Used by the Gateway's guard. */
export function scopeContains(outer: Scope, inner: Scope): boolean {
  if (outer.tenant !== inner.tenant || outer.user !== inner.user) return false;
  if (outer.project === null) return true;
  return outer.project === inner.project;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.tenant === b.tenant && a.user === b.user && a.project === b.project;
}
