import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * A per-conversation working directory, derived from the id rather than random.
 *
 * Derived so a restart lands a resumed conversation in the same place it left
 * off, and so a sweep can match directories to conversations without a second
 * record to keep in sync.
 */
export function workdirFor(sessionRoot: string, conversationId: string): string {
  return join(sessionRoot, createHash('sha256').update(conversationId).digest('hex').slice(0, 24));
}
