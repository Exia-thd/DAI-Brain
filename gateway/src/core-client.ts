import {
  SCOPE_HEADER, formatScopeHeader,
  type GraphResponse, type IngestTranscriptRequest, type IngestTranscriptResponse,
  type MemoryItem, type Scope, type SearchRequest, type SearchResponse,
  type WriteItemRequest, type WriteItemResponse,
} from '@dai-brain/shared';

export class CoreUnavailable extends Error {
  override readonly name = 'CoreUnavailable';
}

/** The Gateway's view of Core. Same shape as the MCP package's, same reasoning. */
export class CoreClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 10_000) {}

  private async request<T>(method: string, path: string, scope: Scope, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { 'content-type': 'application/json', [SCOPE_HEADER]: formatScopeHeader(scope) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* keep raw */ }
        throw new CoreUnavailable(`core ${method} ${path} -> ${response.status}: ${message}`);
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      if (err instanceof CoreUnavailable) throw err;
      throw new CoreUnavailable(`core ${method} ${path} failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  search(scope: Scope, request: SearchRequest): Promise<SearchResponse> {
    return this.request('POST', '/search', scope, request);
  }
  listItems(scope: Scope, query: string): Promise<{ items: MemoryItem[]; total: number }> {
    return this.request('GET', `/items${query}`, scope);
  }
  getItem(scope: Scope, id: string): Promise<MemoryItem> {
    return this.request('GET', `/items/${encodeURIComponent(id)}`, scope);
  }
  writeItem(scope: Scope, request: WriteItemRequest): Promise<WriteItemResponse> {
    return this.request('POST', '/items', scope, request);
  }
  patchItem(scope: Scope, id: string, patch: unknown): Promise<MemoryItem> {
    return this.request('PATCH', `/items/${encodeURIComponent(id)}`, scope, patch);
  }
  deleteItem(scope: Scope, id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/items/${encodeURIComponent(id)}`, scope);
  }
  graph(scope: Scope, name: string, depth: number): Promise<GraphResponse> {
    return this.request('GET', `/entities/${encodeURIComponent(name)}/graph?depth=${depth}`, scope);
  }
  ingestTranscript(scope: Scope, request: IngestTranscriptRequest): Promise<IngestTranscriptResponse> {
    return this.request('POST', '/ingest/transcript', scope, request);
  }
  undo(scope: Scope, conversationId: string): Promise<{ deleted: number }> {
    return this.request('DELETE', `/conversations/${encodeURIComponent(conversationId)}/memory`, scope);
  }
  health(scope: Scope): Promise<unknown> {
    return this.request('GET', '/health', scope);
  }
}
