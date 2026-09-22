import {
  MEMORY_TYPES, badRequest, notFound,
  type GraphResponse, type HealthResponse, type IngestTranscriptRequest,
  type IngestTranscriptResponse, type MemoryItem, type MemoryType, type Scope,
  type SearchRequest, type SearchResponse, type WriteItemRequest,
  type WriteItemResponse, type WriteScope,
} from '@dai-brain/shared';
import type { CoreConfig } from './config.js';
import { probe, embeddingIsVector, type Capabilities } from './db/capabilities.js';
import { createPool, type Db } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embed/index.js';
import { reconcile } from './ingest/reconcile.js';
import { Retriever } from './retrieval/retriever.js';
import {
  expand, findEntity, itemsForEntities, linkItemToEntities, upsertEntity, upsertRelation,
} from './storage/entities.js';
import {
  deleteByConversation, deleteItem, getItem, listItems, updateItem, type ListOptions,
} from './storage/items.js';
import { randomId } from './util/ids.js';

export const VERSION = '0.1.0';

/**
 * Everything Core can do, behind one object.
 *
 * MCP and Gateway both talk to this -- MCP over HTTP, and the write-back worker
 * in-process. Keeping the surface here rather than in the HTTP layer is what
 * makes that possible, and is the reason a second adapter costs a file rather
 * than a refactor.
 */
export class MemoryService {
  private constructor(
    readonly db: Db,
    readonly config: CoreConfig,
    readonly embedder: EmbeddingProvider,
    readonly isVector: boolean,
    readonly retriever: Retriever,
  ) {}

  static async open(config: CoreConfig, options: { migrate?: boolean } = {}): Promise<MemoryService> {
    const db = createPool(config);
    if (options.migrate !== false) await migrate(db, config.embeddingDims);
    const isVector = await embeddingIsVector(db);
    const embedder = createEmbeddingProvider(config);
    const retriever = new Retriever({ db, config, embedder, isVector });
    return new MemoryService(db, config, embedder, isVector, retriever);
  }

  async close(): Promise<void> { await this.db.end(); }

  async capabilities(): Promise<Capabilities> {
    return probe(this.db, this.embedder.status());
  }

  async health(): Promise<HealthResponse> {
    let ok = true;
    let caps: Capabilities;
    try {
      await this.db.query('SELECT 1');
      caps = await this.capabilities();
    } catch (err) {
      ok = false;
      caps = {
        vectorIndex: { status: 'unavailable', detail: (err as Error).message },
        fts: { status: 'unavailable', detail: 'database unreachable' },
        graph: { status: 'unavailable', detail: 'database unreachable' },
        embeddings: this.embedder.status(),
      };
    }
    return { ok, service: 'dai-brain-core', version: VERSION, capabilities: caps };
  }

  search(scope: Scope, request: SearchRequest): Promise<SearchResponse> {
    return this.retriever.search(scope, request);
  }

  getItem(scope: Scope, id: string): Promise<MemoryItem | null> {
    return getItem(this.db, scope, id);
  }

  listItems(scope: Scope, options: ListOptions): Promise<{ items: MemoryItem[]; total: number }> {
    return listItems(this.db, scope, options);
  }

  /**
   * Writes one item: filter, reconcile, then link its entities.
   *
   * Entity linking happens after the write and outside its transaction on
   * purpose. A failed link costs the graph branch one edge, which fusion
   * reports and survives; rolling the item back because an entity name was
   * malformed would lose the memory itself, which it does not.
   */
  async writeItem(scope: WriteScope, request: WriteItemRequest): Promise<WriteItemResponse> {
    if (!MEMORY_TYPES.includes(request.type)) {
      throw badRequest(`type must be one of ${MEMORY_TYPES.join('|')} (got ${request.type})`);
    }
    if (typeof request.content !== 'string' || request.content.trim().length === 0) {
      throw badRequest('content is required');
    }
    if (typeof request.source !== 'string' || request.source.length === 0) {
      throw badRequest('source is required: a memory you cannot trace back is one you cannot check');
    }

    const result = await reconcile(
      this.db, this.embedder, this.isVector, scope,
      {
        scope,
        type: request.type,
        content: request.content,
        source: request.source,
        confidence: request.confidence,
        conversationId: request.conversationId ?? null,
        supersedes: request.supersedes,
      },
      { dedupeThreshold: this.config.dedupeThreshold },
    );

    if (result.outcome !== 'rejected' && request.entities?.length) {
      await this.attachEntities(scope, result.item.id, request.entities);
    }
    // Any write can change what a later search should return, and a 30-second
    // stale answer to "what did I just tell you" is the one kind of staleness
    // a memory system cannot afford.
    this.retriever.clearCache();
    return result;
  }

  private async attachEntities(
    scope: WriteScope,
    itemId: string,
    entities: { name: string; kind?: string }[],
  ): Promise<void> {
    const ids: string[] = [];
    for (const entity of entities.slice(0, 32)) {
      if (!entity?.name?.trim()) continue;
      try {
        const row = await upsertEntity(this.db, scope, entity.name.trim(), entity.kind ?? 'concept');
        ids.push(row.id);
      } catch {
        // A name that normalises to nothing (punctuation only) is not worth
        // failing a write over.
      }
    }
    await linkItemToEntities(this.db, itemId, ids);

    // Co-occurrence is the weakest honest claim available: these names appeared
    // in the same memory. It is labelled RELATES_TO rather than something
    // stronger precisely because nothing here knows *how* they relate.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        await upsertRelation(this.db, ids[i]!, ids[j]!, 'RELATES_TO', 1.0, itemId);
      }
    }
  }

  async updateItem(
    scope: Scope,
    id: string,
    patch: { content?: string; type?: MemoryType; confidence?: number },
  ): Promise<MemoryItem> {
    const embedding = patch.content
      ? { vector: (await this.embedder.embed([patch.content]))[0] ?? [], model: this.embedder.model }
      : null;
    const item = await updateItem(this.db, scope, id, patch, embedding, this.isVector);
    if (!item) throw notFound(`no item ${id} in this scope`);
    this.retriever.clearCache();
    return item;
  }

  async deleteItem(scope: Scope, id: string): Promise<boolean> {
    const ok = await deleteItem(this.db, scope, id);
    this.retriever.clearCache();
    return ok;
  }

  /** Undo one write-back run. See `deleteByConversation`. */
  async undoConversation(scope: Scope, conversationId: string): Promise<number> {
    const n = await deleteByConversation(this.db, scope, conversationId);
    this.retriever.clearCache();
    return n;
  }

  async graph(scope: Scope, name: string, depth: number): Promise<GraphResponse> {
    const root = await findEntity(this.db, scope, name);
    if (!root) {
      return { root: null, entities: [], relations: [], items: [], depth, truncated: false };
    }
    const sub = await expand(this.db, scope, [root.id], depth);
    const pairs = await itemsForEntities(this.db, scope, [...sub.byDepth.keys()], 100);
    const items = await this.itemsByIds(scope, [...new Set(pairs.map((p) => p.itemId))]);
    return {
      root,
      entities: sub.entities,
      relations: sub.relations,
      items,
      depth,
      truncated: sub.truncated,
    };
  }

  private async itemsByIds(scope: Scope, ids: string[]): Promise<MemoryItem[]> {
    const { getItems } = await import('./storage/items.js');
    return getItems(this.db, scope, ids);
  }

  /**
   * Queues a transcript for extraction. It does not extract here.
   *
   * The caller is a request thread the user is waiting on, and extraction is a
   * model call measured in seconds. The queue is a Postgres table because a
   * broker is one more service to run for a queue that will not see a thousand
   * jobs a day.
   */
  async queueTranscript(
    scope: WriteScope,
    request: IngestTranscriptRequest,
  ): Promise<IngestTranscriptResponse> {
    if (!request.conversationId) throw badRequest('conversationId is required');
    if (!Array.isArray(request.turns) || request.turns.length === 0) {
      throw badRequest('turns must be a non-empty array');
    }
    const id = randomId('job');
    await this.db.query(
      `INSERT INTO writeback_jobs (id, conversation_id, tenant, user_id, project, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, request.conversationId, scope.tenant, scope.user, scope.project,
       JSON.stringify({ turns: request.turns })],
    );
    return { jobId: id, queued: true };
  }
}
