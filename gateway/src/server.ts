import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import pg from 'pg';
import {
  Router, SseStream, badRequest, describeError, errorEvent, notFound, parseWriteScope,
  type ChatRequest, type Ctx, type Scope,
} from '@dai-brain/shared';
import { authenticate } from './auth/middleware.js';
import { signJwt } from './auth/jwt.js';
import { startChat, type ChatDeps } from './chat.js';
import { CoreClient } from './core-client.js';
import type { GatewayConfig } from './config.js';
import { ClaudeCliRunner } from './runner/claude-cli.js';
import { PostgresSessionStore } from './sessions/store.js';
import { SqliteSessionStore } from './sessions/sqlite.js';
import { Semaphore } from './runner/semaphore.js';
import type { SessionStore } from './sessions/types.js';
import { WritebackWorker } from './writeback/worker.js';

export const GATEWAY_VERSION = '0.1.0';

export interface Gateway {
  server: Server;
  worker: WritebackWorker | null;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createGatewayRouter(
  config: GatewayConfig,
  deps: ChatDeps & { semaphore: Semaphore; sessions: SessionStore },
): Router {
  const router = new Router();
  const { core, sessions } = deps;

  const scopeOf = (ctx: Ctx, project?: string): Scope => authenticate(config, ctx, project).scope;

  /**
   * The memory explorer needs Brain Core. In the personal setup memory lives
   * behind an MCP server the runner talks to, and the Gateway has no way to
   * read it -- so the endpoint says exactly that instead of failing on a null.
   */
  const requireCore = (): CoreClient => {
    if (!core) {
      throw notFound(
        'This Gateway runs without Brain Core, so it cannot browse memory directly. '
        + 'Memory is reachable through the MCP server the runner is given; ask in the chat instead.',
      );
    }
    return core;
  };

  router.get('/health', async () => ({
    ok: true,
    service: 'dai-brain-gateway',
    version: GATEWAY_VERSION,
    runner: deps.runner.name,
    concurrency: { limit: deps.semaphore.limit, available: deps.semaphore.available, queued: deps.semaphore.queued },
    auth: config.devScope ? 'DEV SCOPE — authentication disabled' : 'jwt',
    // The UI reads these to decide whether to offer the memory explorer.
    store: deps.sessions.kind,
    core: config.coreUrl ?? null,
    memoryExplorer: config.coreUrl !== null,
  }));

  /**
   * Issues a development token.
   *
   * Only reachable when the dev bypass is already on, so it cannot mint a
   * credential on a deployment that has authentication turned on.
   */
  router.post('/auth/dev-token', async (ctx) => {
    if (!config.devScope) throw notFound('dev tokens are only issued when GATEWAY_DEV_SCOPE is set');
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const scope = parseWriteScope({
      tenant: b.tenant ?? config.devScope.split('/')[0],
      user: b.user ?? config.devScope.split('/')[1],
      project: b.project ?? config.devScope.split('/')[2],
    });
    return {
      token: signJwt(
        { sub: scope.user, tenant: scope.tenant, projects: [scope.project] },
        config.jwtSecret || 'dev-secret',
      ),
      scope,
    };
  });

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  router.post('/chat', async (ctx) => {
    const request = (ctx.body ?? {}) as ChatRequest;
    if (typeof request.message !== 'string' || request.message.trim().length === 0) {
      throw badRequest('message is required');
    }
    const scope = parseWriteScope(scopeOf(ctx, request.project));

    const stream = new SseStream(ctx.res);
    const abort = new AbortController();
    // The client hanging up is the signal to kill the process. Without this a
    // closed browser tab leaves a Claude CLI holding a semaphore permit until
    // the request timeout fires, minutes later.
    stream.onClose(() => abort.abort());

    try {
      const turn = await startChat(deps, scope, request, abort.signal);
      for await (const event of turn.events) {
        if (stream.isClosed) break;
        stream.send(event);
      }
    } catch (err) {
      const { code, message } = describeError(err);
      stream.send(errorEvent(code, message));
    } finally {
      abort.abort();
      stream.close();
    }
    return undefined;
  });

  router.get('/conversations', async (ctx) => ({
    conversations: await sessions.list(scopeOf(ctx, ctx.url.searchParams.get('project') ?? undefined)),
  }));

  router.get('/conversations/:id', async (ctx) => {
    const scope = scopeOf(ctx);
    const conversation = await sessions.get(scope, ctx.params.id!);
    if (!conversation) throw notFound(`no conversation ${ctx.params.id}`);
    return {
      id: conversation.id,
      title: conversation.title,
      messages: await sessions.messages(conversation.id),
    };
  });

  router.delete('/conversations/:id', async (ctx) => ({
    deleted: await sessions.delete(scopeOf(ctx), ctx.params.id!),
  }));

  /** Undo: drops every memory this conversation's write-back created. */
  router.delete('/conversations/:id/memory', async (ctx) => requireCore().undo(scopeOf(ctx), ctx.params.id!));

  // -------------------------------------------------------------------------
  // Memory explorer — the debugging surface, proxied so the UI needs one origin
  // and one credential rather than two.
  // -------------------------------------------------------------------------

  router.get('/memory/items', async (ctx) => {
    const scope = scopeOf(ctx, ctx.url.searchParams.get('project') ?? undefined);
    const query = new URLSearchParams();
    for (const key of ['limit', 'offset', 'contains', 'types', 'includeSuperseded']) {
      const value = ctx.url.searchParams.get(key);
      if (value) query.set(key, value);
    }
    const qs = query.toString();
    return requireCore().listItems(scope, qs ? `?${qs}` : '');
  });

  router.get('/memory/items/:id', async (ctx) => requireCore().getItem(scopeOf(ctx), ctx.params.id!));
  router.patch('/memory/items/:id', async (ctx) => requireCore().patchItem(scopeOf(ctx), ctx.params.id!, ctx.body));
  router.delete('/memory/items/:id', async (ctx) => requireCore().deleteItem(scopeOf(ctx), ctx.params.id!));

  router.post('/memory/search', async (ctx) => {
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    if (typeof b.query !== 'string') throw badRequest('query is required');
    return requireCore().search(scopeOf(ctx, b.project as string | undefined), b as never);
  });

  router.post('/memory/items', async (ctx) => requireCore().writeItem(
    parseWriteScope(scopeOf(ctx, (ctx.body as Record<string, unknown>)?.project as string | undefined)),
    ctx.body as never,
  ));

  router.get('/memory/entities/:name/graph', async (ctx) => requireCore().graph(
    scopeOf(ctx),
    ctx.params.name!,
    Number.parseInt(ctx.url.searchParams.get('depth') ?? '1', 10) || 1,
  ));

  // -------------------------------------------------------------------------
  // Static UI
  // -------------------------------------------------------------------------

  if (config.uiRoot) {
    const root = resolve(config.uiRoot);
    const serve = async (ctx: Ctx) => {
      const requested = ctx.url.pathname === '/' ? '/index.html' : ctx.url.pathname;
      // Resolve, then check containment. Checking the raw path for '..' misses
      // encoded traversals; checking the resolved one cannot.
      const target = resolve(join(root, normalize(requested)));
      if (target !== root && !target.startsWith(root + sep)) throw notFound('not found');
      try {
        const body = await readFile(target);
        ctx.res.writeHead(200, {
          'content-type': MIME[extname(target)] ?? 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-cache',
        });
        ctx.res.end(body);
      } catch {
        throw notFound(`no such file ${requested}`);
      }
      return undefined;
    };
    router.get('/', serve);
    router.get('/:file', serve);
    router.get('/assets/:file', serve);
  }

  return router;
}

export async function startGateway(config: GatewayConfig): Promise<Gateway> {
  let pool: pg.Pool | null = null;
  let sessions: SessionStore;

  if (config.databaseUrl) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on('error', (err) => console.error('[gateway] idle pg client error:', err.message));
    sessions = new PostgresSessionStore(pool, config.sessionRoot);
  } else {
    sessions = new SqliteSessionStore(config.sqlitePath, config.sessionRoot);
  }

  const core = config.coreUrl ? new CoreClient(config.coreUrl) : null;
  const semaphore = new Semaphore(config.maxConcurrency);
  const runner = new ClaudeCliRunner(config, semaphore);
  const deps: ChatDeps & { semaphore: Semaphore; sessions: SessionStore } = {
    config, core, sessions, runner, semaphore,
  };

  const server = createServer(createGatewayRouter(config, deps).listener());
  await new Promise<void>((resolve) => server.listen(config.port, resolve));

  // The queue is a Postgres table, so write-back needs both it and Core.
  const worker = config.writebackEnabled && pool && core
    ? new WritebackWorker(pool, core, config)
    : null;
  worker?.start();

  return {
    server,
    worker,
    async close() {
      worker?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sessions.close();
    },
  };
}
