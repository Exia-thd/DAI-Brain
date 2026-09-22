import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SCOPE_HEADER, parseScopeHeader, type Scope } from '@dai-brain/shared';
import { CoreClient, CoreClientError } from './core-client.js';
import {
  GET_DESCRIPTION, GRAPH_DESCRIPTION, SEARCH_DESCRIPTION, WRITE_DESCRIPTION,
  getSchema, graphSchema, runGet, runGraph, runSearch, runWrite, searchSchema, writeSchema,
  type ToolContext,
} from './tools.js';

export const MCP_VERSION = '0.1.0';

type TextResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): TextResult => ({ content: [{ type: 'text', text }] });

/**
 * A tool error is a message to the model, not a stack trace.
 *
 * The model is the one who has to decide what to do next, and "Core unreachable"
 * with an instruction is actionable where a rethrown exception is noise it will
 * either ignore or repeat verbatim to the user.
 */
function failed(err: unknown): TextResult {
  const message = err instanceof CoreClientError
    ? (err.status === 404
        ? `${err.message}`
        : `Memory service error (${err.status}): ${err.message}`)
    : `Memory service error: ${(err as Error).message}`;
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Builds a server bound to one scope.
 *
 * One server per request rather than one per process, because the scope is
 * per-request and an `McpServer` that outlived it would be a handle onto
 * another user's memory. The SDK's streamable HTTP transport is designed for
 * this: stateless mode, new instance per call, no session state to leak.
 */
export function createMcpServer(core: CoreClient, scope: Scope): McpServer {
  const server = new McpServer(
    { name: 'dai-brain-memory', version: MCP_VERSION },
    {
      instructions:
        'Long-term memory for this user. Search it before answering anything that might '
        + 'depend on an earlier conversation, and write to it when the user states a '
        + 'decision, a preference or a durable fact. Memory ids look like `item_…`; cite '
        + 'them so the user can check what you used.',
    },
  );
  const ctx: ToolContext = { core, scope };

  server.tool('memory_search', SEARCH_DESCRIPTION, searchSchema, async (args) => {
    try { return ok(await runSearch(ctx, args as never)); } catch (err) { return failed(err); }
  });

  server.tool('memory_graph_explore', GRAPH_DESCRIPTION, graphSchema, async (args) => {
    try { return ok(await runGraph(ctx, args as never)); } catch (err) { return failed(err); }
  });

  server.tool('memory_get', GET_DESCRIPTION, getSchema, async (args) => {
    try { return ok(await runGet(ctx, args as never)); } catch (err) { return failed(err); }
  });

  server.tool('memory_write', WRITE_DESCRIPTION, writeSchema, async (args) => {
    try { return ok(await runWrite(ctx, args as never)); } catch (err) { return failed(err); }
  });

  return server;
}

export interface McpHandlerOptions {
  coreUrl: string;
  timeoutMs?: number;
}

/**
 * A node:http listener that serves MCP over streamable HTTP.
 *
 * Scope arrives in the X-Scope header, set by the Gateway. A request without
 * one is refused rather than defaulted: this process cannot know whose memory
 * the caller meant, and guessing is the cross-user read the scope model exists
 * to prevent.
 */
export function createMcpHandler(options: McpHandlerOptions) {
  const core = new CoreClient(options.coreUrl, options.timeoutMs);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, service: 'dai-brain-mcp', version: MCP_VERSION }));
      return;
    }

    let scope: Scope;
    try {
      scope = parseScopeHeader(req.headers[SCOPE_HEADER] as string | undefined);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: (err as Error).message },
        id: null,
      }));
      return;
    }

    const server = createMcpServer(core, scope);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: the Gateway owns session identity, and a second source of
      // session state is a second thing that can disagree about who is asking.
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: (err as Error).message },
          id: null,
        }));
      }
    }
  };
}
