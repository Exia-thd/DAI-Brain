import type { Scope } from '@dai-brain/shared';

/**
 * The only way a scope becomes SQL.
 *
 * Every table that holds user content carries (tenant, user_id, project), and
 * every query against one goes through here. Centralising it is the point: a
 * missed scope predicate is a cross-user read, and the way that bug ships is a
 * hand-written WHERE clause that forgot one column. There is no variant of this
 * function that takes an optional scope.
 */
export function scopeWhere(
  scope: Scope,
  params: unknown[],
  alias = '',
): string {
  const p = alias ? `${alias}.` : '';
  const clauses = [
    `${p}tenant = $${params.push(scope.tenant)}`,
    `${p}user_id = $${params.push(scope.user)}`,
  ];
  // A null project means "every project this user has" -- a deliberate widening
  // for cross-project recall, and never a widening past the user.
  if (scope.project !== null) {
    clauses.push(`${p}project = $${params.push(scope.project)}`);
  }
  return clauses.join(' AND ');
}

/** A stable key for caches and derived ids. Order is fixed so it never varies. */
export function scopeKey(scope: Scope): string {
  return `${scope.tenant}/${scope.user}/${scope.project ?? '*'}`;
}
