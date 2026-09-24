/**
 * A router small enough to read in one sitting.
 *
 * Core, MCP and Gateway are all thin HTTP surfaces; a framework would be more
 * dependency than routing. Everything here is node:http and nothing else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorCode } from './events.js';

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, 'bad_request', m);
export const unauthorized = (m: string) => new HttpError(401, 'unauthorized', m);
export const forbidden = (m: string) => new HttpError(403, 'forbidden', m);
export const notFound = (m: string) => new HttpError(404, 'not_found', m);

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body, or undefined for bodyless methods. */
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  /** Segments; `:name` captures. */
  segments: string[];
  handler: Handler;
}

/** Exported so a caller sizing its own limits can check they fit under this. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: path.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  /** Returns a node:http listener. Handlers return a value; it is sent as JSON. */
  listener() {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      try {
        if (req.method === 'OPTIONS') {
          cors(res);
          res.writeHead(204).end();
          return;
        }
        const hit = this.match(req.method ?? 'GET', url.pathname);
        if (!hit) throw notFound(`no route for ${req.method} ${url.pathname}`);

        const body = req.method === 'GET' || req.method === 'DELETE'
          ? undefined
          : await readJson(req);

        const out = await hit.route.handler({ req, res, url, params: hit.params, body });
        // A handler that wrote the response itself (SSE, streaming) returns
        // undefined and owns the socket from here.
        if (out === undefined || res.writableEnded) return;
        sendJson(res, 200, out);
      } catch (err) {
        sendError(res, err);
      }
    };
  }
}

export function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-scope, last-event-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw badRequest('request body too large');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  cors(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  const { status, code, message } = describeError(err);
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(); return; }
  sendJson(res, status, { error: { code, message } });
}

export function describeError(err: unknown): { status: number; code: ErrorCode; message: string } {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  // ScopeError arrives by name rather than by instanceof: shared is a single
  // package here, but the two would be separate copies across a bundler
  // boundary, and a scope failure must not degrade into a 500.
  if (err instanceof Error && err.name === 'ScopeError') {
    return { status: 400, code: 'scope_error', message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, code: 'internal', message };
}
