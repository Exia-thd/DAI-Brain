import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import type { ConversationSummary, Scope, WriteScope } from '@dai-brain/shared';
import type { Conversation, SessionStore, TranscriptMessage, TurnUsage } from './types.js';

import { workdirFor } from './workdir.js';

/**
 * Conversations and their mapping to Claude sessions.
 *
 * The pairing lives in Postgres rather than in memory because `--resume` is the
 * only thing that makes a multi-turn conversation cheap, and a Gateway restart
 * that forgets every session id silently turns every ongoing conversation into
 * a new one with no history.
 */
export class PostgresSessionStore implements SessionStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: pg.Pool, private readonly sessionRoot: string) {}

  private workdirFor(id: string): string {
    return workdirFor(this.sessionRoot, id);
  }

  async close(): Promise<void> { await this.db.end(); }

  async create(scope: WriteScope, title: string): Promise<Conversation> {
    const id = `conv_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const workdir = this.workdirFor(id);
    await this.db.query(
      `INSERT INTO conversations (id, tenant, user_id, project, title, workdir)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, scope.tenant, scope.user, scope.project, title.slice(0, 200), workdir],
    );
    return { id, scope, title, claudeSessionId: null, workdir };
  }

  async get(scope: Scope, id: string): Promise<Conversation | null> {
    const params: unknown[] = [id, scope.tenant, scope.user];
    let where = 'id = $1 AND tenant = $2 AND user_id = $3';
    if (scope.project !== null) where += ` AND project = $${params.push(scope.project)}`;

    const { rows } = await this.db.query<{
      id: string; tenant: string; user_id: string; project: string;
      title: string; claude_session_id: string | null; workdir: string | null;
    }>(`SELECT id, tenant, user_id, project, title, claude_session_id, workdir
          FROM conversations WHERE ${where}`, params);

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      scope: { tenant: row.tenant, user: row.user_id, project: row.project },
      title: row.title,
      claudeSessionId: row.claude_session_id,
      workdir: row.workdir ?? this.workdirFor(row.id),
    };
  }

  async bindClaudeSession(conversationId: string, sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET claude_session_id = $2, updated_at = now() WHERE id = $1`,
      [conversationId, sessionId],
    );
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET title = $2, updated_at = now()
        WHERE id = $1 AND (title = '' OR title IS NULL)`,
      [conversationId, title.slice(0, 200)],
    );
  }

  async appendMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1,$2,$3)`,
      [conversationId, role, content],
    );
    await this.db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  }

  async messages(conversationId: string): Promise<TranscriptMessage[]> {
    const { rows } = await this.db.query<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [conversationId],
    );
    return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  async recordUsage(conversationId: string, usage: TurnUsage): Promise<void> {
    await this.db.query(
      `INSERT INTO turn_usage (conversation_id, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4)`,
      [conversationId, usage.inputTokens, usage.outputTokens, usage.costUsd],
    );
  }

  async spend(conversationId: string): Promise<{ costUsd: number; turns: number }> {
    const { rows } = await this.db.query<{ cost: string | null; turns: string }>(
      `SELECT coalesce(sum(cost_usd), 0)::text AS cost, count(*)::text AS turns
         FROM turn_usage WHERE conversation_id = $1`,
      [conversationId],
    );
    return { costUsd: Number(rows[0]?.cost ?? 0), turns: Number(rows[0]?.turns ?? 0) };
  }

  async list(scope: Scope, limit = 50): Promise<ConversationSummary[]> {
    const params: unknown[] = [scope.tenant, scope.user];
    let where = 'c.tenant = $1 AND c.user_id = $2';
    if (scope.project !== null) where += ` AND c.project = $${params.push(scope.project)}`;

    const { rows } = await this.db.query<{
      id: string; title: string; created_at: Date; updated_at: Date; turns: string;
    }>(`SELECT c.id, c.title, c.created_at, c.updated_at,
               (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::text AS turns
          FROM conversations c WHERE ${where}
         ORDER BY c.updated_at DESC LIMIT $${params.push(limit)}`, params);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      turnCount: Number(r.turns),
    }));
  }

  async delete(scope: Scope, id: string): Promise<boolean> {
    const params: unknown[] = [id, scope.tenant, scope.user];
    let where = 'id = $1 AND tenant = $2 AND user_id = $3';
    if (scope.project !== null) where += ` AND project = $${params.push(scope.project)}`;
    const { rowCount } = await this.db.query(`DELETE FROM conversations WHERE ${where}`, params);
    return (rowCount ?? 0) > 0;
  }
}
