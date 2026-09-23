import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationSummary, Scope, WriteScope } from '@dai-brain/shared';
import type { Conversation, SessionStore, TranscriptMessage } from './types.js';
import { workdirFor } from './workdir.js';

/**
 * Conversations in a local file, for one person on one machine.
 *
 * `node:sqlite` rather than a driver, so this costs no dependency at all. The
 * scope columns are kept even though a personal store has exactly one scope:
 * dropping them would make this store a different shape from the Postgres one,
 * and the first bug after that would be a query that works against one and
 * silently returns everything against the other.
 *
 * Timestamps are ISO strings. SQLite has no date type, and a number would
 * require every read to remember which unit it was written in.
 */
export class SqliteSessionStore implements SessionStore {
  readonly kind = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly sessionRoot: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL so a reader (the UI listing conversations) is not blocked by the
    // writer (a turn in flight). Both are this process, but the Gateway
    // interleaves them and the default journal makes that a lock wait.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id                TEXT PRIMARY KEY,
        tenant            TEXT NOT NULL,
        user_id           TEXT NOT NULL,
        project           TEXT NOT NULL,
        title             TEXT NOT NULL DEFAULT '',
        claude_session_id TEXT,
        workdir           TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_scope_idx
        ON conversations (tenant, user_id, project, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx
        ON messages (conversation_id, id);
    `);
  }

  private now(): string { return new Date().toISOString(); }

  async create(scope: WriteScope, title: string): Promise<Conversation> {
    const id = `conv_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const workdir = workdirFor(this.sessionRoot, id);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO conversations (id, tenant, user_id, project, title, workdir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, scope.tenant, scope.user, scope.project, title.slice(0, 200), workdir, now, now);
    return { id, scope, title, claudeSessionId: null, workdir };
  }

  async get(scope: Scope, id: string): Promise<Conversation | null> {
    // A null project means every project of this user, exactly as in Postgres.
    const row = (scope.project === null
      ? this.db.prepare(
          `SELECT * FROM conversations WHERE id = ? AND tenant = ? AND user_id = ?`,
        ).get(id, scope.tenant, scope.user)
      : this.db.prepare(
          `SELECT * FROM conversations WHERE id = ? AND tenant = ? AND user_id = ? AND project = ?`,
        ).get(id, scope.tenant, scope.user, scope.project)) as Record<string, string> | undefined;

    if (!row) return null;
    return {
      id: row.id!,
      scope: { tenant: row.tenant!, user: row.user_id!, project: row.project! },
      title: row.title ?? '',
      claudeSessionId: row.claude_session_id ?? null,
      workdir: row.workdir ?? workdirFor(this.sessionRoot, row.id!),
    };
  }

  async bindClaudeSession(conversationId: string, sessionId: string): Promise<void> {
    this.db.prepare(
      `UPDATE conversations SET claude_session_id = ?, updated_at = ? WHERE id = ?`,
    ).run(sessionId, this.now(), conversationId);
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    this.db.prepare(
      `UPDATE conversations SET title = ?, updated_at = ?
        WHERE id = ? AND (title = '' OR title IS NULL)`,
    ).run(title.slice(0, 200), this.now(), conversationId);
  }

  async appendMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run(conversationId, role, content, now);
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
  }

  async messages(conversationId: string): Promise<TranscriptMessage[]> {
    const rows = this.db.prepare(
      `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id`,
    ).all(conversationId) as { role: string; content: string }[];
    return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  async list(scope: Scope, limit = 50): Promise<ConversationSummary[]> {
    const sql = `SELECT c.id, c.title, c.created_at, c.updated_at,
        (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS turns
      FROM conversations c
      WHERE c.tenant = ? AND c.user_id = ?${scope.project === null ? '' : ' AND c.project = ?'}
      ORDER BY c.updated_at DESC LIMIT ?`;
    const params = scope.project === null
      ? [scope.tenant, scope.user, limit]
      : [scope.tenant, scope.user, scope.project, limit];

    const rows = this.db.prepare(sql).all(...params) as Record<string, string | number>[];
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      turnCount: Number(r.turns ?? 0),
    }));
  }

  async delete(scope: Scope, id: string): Promise<boolean> {
    const result = scope.project === null
      ? this.db.prepare(`DELETE FROM conversations WHERE id = ? AND tenant = ? AND user_id = ?`)
          .run(id, scope.tenant, scope.user)
      : this.db.prepare(`DELETE FROM conversations WHERE id = ? AND tenant = ? AND user_id = ? AND project = ?`)
          .run(id, scope.tenant, scope.user, scope.project);
    return Number(result.changes) > 0;
  }

  async close(): Promise<void> { this.db.close(); }
}
