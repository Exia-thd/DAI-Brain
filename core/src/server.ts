import { createServer, type Server } from 'node:http';
import {
  Router, SCOPE_HEADER, badRequest, notFound, parseScopeHeader, parseWriteScope,
  type Ctx, type MemoryType, type Scope, type WriteScope,
} from '@dai-brain/shared';
import type { CoreConfig } from './config.js';
import { MemoryService } from './service.js';

/**
 * Core's scope comes from one header and nowhere else.
 *
 * Not from the body, not from a query parameter, and never from anything a
 * model produced. The Gateway is the only component that decides what scope a
 * request carries; Core's job is to refuse a request that does not state one.
 */
function scopeOf(ctx: Ctx): Scope {
  return parseScopeHeader(ctx.req.headers[SCOPE_HEADER] as string | undefined);
}

function writeScopeOf(ctx: Ctx): WriteScope {
  return parseWriteScope(scopeOf(ctx));
}

function body(ctx: Ctx): Record<string, unknown> {
  if (typeof ctx.body !== 'object' || ctx.body === null) throw badRequest('a JSON object body is required');
  return ctx.body as Record<string, unknown>;
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw badRequest(`${name} must be an integer`);
  return n;
}

export function createCoreRouter(service: MemoryService): Router {
  const router = new Router();

  router.get('/health', () => service.health());

  router.post('/search', async (ctx) => {
    const b = body(ctx);
    if (typeof b.query !== 'string') throw badRequest('query must be a string');
    return service.search(scopeOf(ctx), {
      query: b.query,
      maxTokens: b.maxTokens as number | undefined,
      limit: b.limit as number | undefined,
      types: b.types as MemoryType[] | undefined,
      graphDepth: b.graphDepth as number | undefined,
      rerank: b.rerank as boolean | undefined,
      includeSuperseded: b.includeSuperseded as boolean | undefined,
    });
  });

  router.get('/items', async (ctx) => service.listItems(scopeOf(ctx), {
    limit: intParam(ctx.url, 'limit', 50),
    offset: intParam(ctx.url, 'offset', 0),
    includeSuperseded: ctx.url.searchParams.get('includeSuperseded') === 'true',
    contains: ctx.url.searchParams.get('contains') ?? undefined,
    types: ctx.url.searchParams.get('types')?.split(',').filter(Boolean) as MemoryType[] | undefined,
  }));

  router.get('/items/:id', async (ctx) => {
    const item = await service.getItem(scopeOf(ctx), ctx.params.id!);
    if (!item) throw notFound(`no item ${ctx.params.id} in this scope`);
    return item;
  });

  router.post('/items', async (ctx) => {
    const b = body(ctx);
    return service.writeItem(writeScopeOf(ctx), {
      type: b.type as MemoryType,
      content: b.content as string,
      source: b.source as string,
      confidence: b.confidence as number | undefined,
      conversationId: b.conversationId as string | undefined,
      entities: b.entities as { name: string; kind?: string }[] | undefined,
      supersedes: b.supersedes as string | undefined,
    });
  });

  router.patch('/items/:id', async (ctx) => {
    const b = body(ctx);
    return service.updateItem(scopeOf(ctx), ctx.params.id!, {
      content: b.content as string | undefined,
      type: b.type as MemoryType | undefined,
      confidence: b.confidence as number | undefined,
    });
  });

  router.delete('/items/:id', async (ctx) => {
    const deleted = await service.deleteItem(scopeOf(ctx), ctx.params.id!);
    if (!deleted) throw notFound(`no item ${ctx.params.id} in this scope`);
    return { deleted: true };
  });

  router.get('/entities/:name/graph', async (ctx) => service.graph(
    scopeOf(ctx), ctx.params.name!, intParam(ctx.url, 'depth', 1),
  ));

  router.post('/ingest/transcript', async (ctx) => {
    const b = body(ctx);
    return service.queueTranscript(writeScopeOf(ctx), {
      conversationId: b.conversationId as string,
      turns: (b.turns ?? []) as { role: 'user' | 'assistant'; content: string }[],
    });
  });

  // Undo, as the plan requires: everything one write-back run created, gone.
  router.delete('/conversations/:id/memory', async (ctx) => ({
    deleted: await service.undoConversation(scopeOf(ctx), ctx.params.id!),
  }));

  return router;
}

export async function startCore(config: CoreConfig): Promise<{ server: Server; service: MemoryService }> {
  const service = await MemoryService.open(config);
  const server = createServer(createCoreRouter(service).listener());
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  return { server, service };
}
