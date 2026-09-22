import type pg from 'pg';
import type { TranscriptTurn, WriteScope } from '@dai-brain/shared';
import type { GatewayConfig } from '../config.js';
import type { CoreClient } from '../core-client.js';
import { extractFacts, type ExtractedFact } from './extract.js';

interface Job {
  id: string;
  conversationId: string;
  scope: WriteScope;
  turns: TranscriptTurn[];
  attempts: number;
}

const MAX_ATTEMPTS = 3;

export interface WorkerStats {
  processed: number;
  stored: number;
  duplicates: number;
  rejected: number;
  failed: number;
}

/**
 * Drains the write-back queue.
 *
 * A single worker polling a table, which is the whole design. The claim is done
 * with `FOR UPDATE SKIP LOCKED` so running two of these is safe without either
 * one knowing about the other, and a job whose worker dies mid-flight is left
 * in `running` rather than lost -- visible, and requeueable by hand, which is
 * the right trade for a queue this small.
 */
export class WritebackWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly stats: WorkerStats = { processed: 0, stored: 0, duplicates: 0, rejected: 0, failed: 0 };

  constructor(
    private readonly db: pg.Pool,
    private readonly core: CoreClient,
    private readonly config: GatewayConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => { void this.drain().finally(() => { if (!this.stopped) schedule(); }); };
    const schedule = () => {
      this.timer = setTimeout(tick, this.config.writebackPollMs);
      this.timer.unref?.();
    };
    schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  async drain(limit = 5): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < limit; i++) {
        const job = await this.claim();
        if (!job) return;
        await this.process(job);
      }
    } catch (err) {
      console.error(`[writeback] drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<Job | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        id: string; conversation_id: string; tenant: string; user_id: string;
        project: string; payload: { turns: TranscriptTurn[] }; attempts: number;
      }>(`SELECT id, conversation_id, tenant, user_id, project, payload, attempts
            FROM writeback_jobs WHERE status = 'pending'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = rows[0];
      if (!row) { await client.query('COMMIT'); return null; }

      await client.query(
        `UPDATE writeback_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await client.query('COMMIT');

      return {
        id: row.id,
        conversationId: row.conversation_id,
        scope: { tenant: row.tenant, user: row.user_id, project: row.project },
        turns: row.payload?.turns ?? [],
        attempts: row.attempts + 1,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async process(job: Job): Promise<void> {
    this.stats.processed++;
    try {
      const facts = await extractFacts(job.turns, {
        claudeBin: this.config.claudeBin,
        model: this.config.writebackModel,
      });
      const kept = facts.filter((f) => f.confidence >= this.config.writebackMinConfidence);
      const summary = await this.store(job, kept);

      await this.db.query(
        `UPDATE writeback_jobs SET status = 'done', updated_at = now(), error = $2 WHERE id = $1`,
        [job.id, summary],
      );
      console.log(`[writeback] ${job.conversationId}: ${summary}`);
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      this.stats.failed++;
      // A job that has burned its attempts stops rather than looping: three
      // failures of the same transcript is a transcript the extractor cannot
      // read, and retrying it forever starves the jobs behind it.
      const status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await this.db.query(
        `UPDATE writeback_jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
        [job.id, status, message],
      );
      console.error(`[writeback] ${job.conversationId} ${status} (attempt ${job.attempts}): ${message}`);
    }
  }

  private async store(job: Job, facts: ExtractedFact[]): Promise<string> {
    let stored = 0;
    let duplicates = 0;
    let rejected = 0;

    for (const fact of facts) {
      const result = await this.core.writeItem(job.scope, {
        type: fact.type,
        content: fact.content,
        source: `conversation:${job.conversationId}`,
        confidence: fact.confidence,
        // Stamping the conversation on every derived item is what makes the
        // undo in the plan possible at all.
        conversationId: job.conversationId,
        entities: fact.entities,
      });
      switch (result.outcome) {
        case 'inserted': case 'superseded': stored++; break;
        case 'duplicate': case 'updated': duplicates++; break;
        default: rejected++;
      }
    }

    this.stats.stored += stored;
    this.stats.duplicates += duplicates;
    this.stats.rejected += rejected;
    return `${facts.length} extracted, ${stored} stored, ${duplicates} already known, ${rejected} rejected`;
  }
}
