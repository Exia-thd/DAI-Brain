import { parseScopeHeader, unauthorized, type Ctx, type Scope } from '@dai-brain/shared';
import type { GatewayConfig } from '../config.js';
import { scopeFor, verifyJwt, type Claims } from './jwt.js';

export interface Principal {
  scope: Scope;
  claims: Claims;
}

/**
 * Resolves who is asking, from the Authorization header and nothing else.
 *
 * The dev bypass is deliberately loud and deliberately narrow: it is refused
 * at boot when NODE_ENV=production, so the convenient path cannot become the
 * deployed one by accident.
 */
export function authenticate(config: GatewayConfig, ctx: Ctx, requestedProject?: string): Principal {
  if (config.devScope) {
    const scope = parseScopeHeader(config.devScope);
    return {
      scope: requestedProject ? { ...scope, project: requestedProject } : scope,
      claims: { sub: scope.user, tenant: scope.tenant, projects: ['*'] },
    };
  }

  const header = ctx.req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Authorization: Bearer <jwt> is required');
  }
  const claims = verifyJwt(header.slice('Bearer '.length).trim(), config.jwtSecret);
  return { scope: scopeFor(claims, requestedProject), claims };
}
