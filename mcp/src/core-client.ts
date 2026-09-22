import {
  SCOPE_HEADER, formatScopeHeader,
  type GraphResponse, type MemoryItem, type Scope, type SearchRequest,
  type SearchResponse, type WriteItemRequest, type WriteItemResponse,
} from '@dai-brain/shared';

export class CoreClientError extends Error {
  override readonly name = 'CoreClientError';
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * A typed fetch wrapper over Core, and the only thing in this package that
 * knows Core exists.
 *
 * Every method takes the scope explicitly. There is no client-wide default,
 * because a default scope is a scope that outlives the request that justified
 * it -- and this process serves more than one user.
 */
export class CoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    scope: Scope,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          [SCOPE_HEADER]: formatScopeHeader(scope),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
        } catch { /* a non-JSON error body is still the best message available */ }
        throw new CoreClientError(response.status, message);
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      if (err instanceof CoreClientError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new CoreClientError(504, `Core did not answer within ${this.timeoutMs}ms`);
      }
      throw new CoreClientError(502, `Core unreachable at ${this.baseUrl}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  search(scope: Scope, request: SearchRequest): Promise<SearchResponse> {
    return this.request('POST', '/search', scope, request);
  }

  getItem(scope: Scope, id: string): Promise<MemoryItem> {
    return this.request('GET', `/items/${encodeURIComponent(id)}`, scope);
  }

  writeItem(scope: Scope, request: WriteItemRequest): Promise<WriteItemResponse> {
    return this.request('POST', '/items', scope, request);
  }

  graph(scope: Scope, name: string, depth: number): Promise<GraphResponse> {
    return this.request('GET', `/entities/${encodeURIComponent(name)}/graph?depth=${depth}`, scope);
  }

  health(scope: Scope): Promise<{ ok: boolean }> {
    return this.request('GET', '/health', scope);
  }
}
