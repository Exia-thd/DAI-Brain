import { errorEvent, type BrainEvent, type Citation } from '@dai-brain/shared';
import type { StreamLine } from '../runner/types.js';

const MEMORY_TOOL = /^mcp__memory__/;

/**
 * Any memory server's tools, not just Brain MCP's.
 *
 * Brain MCP names them `memory_*` and the DAI memory plugin names them
 * `dai_memory_*`, so this asks whether a tool came from something calling
 * itself memory rather than from one specific server.
 */
const ANY_MEMORY_TOOL = /^mcp__[\w-]*memory[\w-]*__/;

export interface TranslateResult {
  events: BrainEvent[];
  /** Claude's session id, once the stream reveals it. */
  sessionId: string | null;
  /** Assistant text seen so far, accumulated for the transcript. */
  assistantText: string;
  done: boolean;
}

/**
 * Turns Claude's stream-json into the UI's six events.
 *
 * Stateful because the CLI's stream is: a tool's name arrives on the block that
 * starts it and its result arrives later keyed only by id, so something has to
 * remember the pairing. Keeping that state here means the UI never sees a tool
 * result it cannot label, and the Runner never has to care what a UI event is.
 *
 * It is written to tolerate an unfamiliar line rather than fail on one. The
 * CLI's output shape is not a frozen contract, and a translator that throws on
 * an unknown `type` turns a CLI upgrade into an outage.
 */
export class StreamTranslator {
  private sessionId: string | null = null;
  private assistantText = '';
  /** toolId -> name, so a result can be labelled when it arrives. */
  private readonly toolNames = new Map<string, string>();
  private sawInit = false;
  /** Memory tools the session actually got, from the init line. */
  private memoryToolNames: string[] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd: number | null = null;
  private stopReason: string | null = null;

  constructor(private readonly conversationId: string) {}

  get claudeSessionId(): string | null { return this.sessionId; }
  get text(): string { return this.assistantText; }
  get memoryTools(): readonly string[] { return this.memoryToolNames; }

  translate(line: StreamLine): BrainEvent[] {
    if (typeof line.session_id === 'string') this.sessionId = line.session_id;

    switch (line.type) {
      case 'system':
        return this.fromInit(line);

      case 'assistant':
        return this.fromAssistantMessage(line);

      case 'content_block_delta':
        if (line.delta?.type === 'text_delta' && typeof line.delta.text === 'string') {
          this.assistantText += line.delta.text;
          return [{ type: 'message.delta', text: line.delta.text }];
        }
        return [];

      case 'content_block_start': {
        const block = line.content_block;
        if (block?.type === 'tool_use' && block.id && block.name) {
          this.toolNames.set(block.id, block.name);
          return [{
            type: 'tool.start',
            toolId: block.id,
            name: block.name,
            input: block.input ?? {},
          }];
        }
        return [];
      }

      case 'user':
        // Tool results come back as a user-role message. This is where a memory
        // search becomes a citation event.
        return this.fromToolResults(line);

      case 'result':
        return this.fromResult(line);

      default:
        return [];
    }
  }

  /**
   * The init line is the only place the CLI says whether memory came up.
   *
   * It was discarded, and that is how a chat window spent a session answering
   * from nothing: the memory server failed to start, every tool call was
   * refused, and the only sign of it was the model changing the subject. A
   * retrieval path that falls back has to name itself, and this is the one
   * moment that information exists.
   *
   * An unreachable memory server is reported as an error rather than a note.
   * The answer that follows is ungrounded, which is the failure this whole
   * system is built to make visible, and marking the turn failed also keeps
   * its transcript out of write-back -- memory should not learn from a turn
   * that could not read memory.
   */
  private fromInit(line: StreamLine): BrainEvent[] {
    // `system` covers more than init, and a resumed session repeats it.
    if (line.subtype !== 'init' || this.sawInit) return [];
    this.sawInit = true;

    const servers = Array.isArray(line.mcp_servers) ? line.mcp_servers : [];
    const tools = Array.isArray(line.tools) ? line.tools.filter((t): t is string => typeof t === 'string') : [];
    this.memoryToolNames = tools.filter((t) => ANY_MEMORY_TOOL.test(t));

    const events: BrainEvent[] = [];
    for (const server of servers) {
      const status = typeof server?.status === 'string' ? server.status : 'unknown';
      if (status === 'connected') continue;
      events.push(errorEvent(
        'upstream_failed',
        `The ${server?.name ?? 'unnamed'} MCP server did not connect (${status}), `
        + 'so this answer is not grounded in memory.',
      ));
    }

    // Servers up but no memory tools means the allow list and the server
    // disagree about what the tools are called -- the failure that looks
    // exactly like an empty memory.
    if (servers.length > 0 && events.length === 0 && this.memoryToolNames.length === 0) {
      events.push(errorEvent(
        'upstream_failed',
        `The memory server connected but this session has no memory tools. `
        + `It offered: ${servers.map((s) => s?.name ?? '?').join(', ')}. `
        + 'Check that the allowed tools name that server.',
      ));
    }
    return events;
  }

  private fromAssistantMessage(line: StreamLine): BrainEvent[] {
    const content = line.message?.content;
    const usage = line.message?.usage;
    if (usage) {
      this.inputTokens += usage.input_tokens ?? 0;
      this.outputTokens += usage.output_tokens ?? 0;
    }
    if (line.message?.stop_reason) this.stopReason = line.message.stop_reason;
    if (!Array.isArray(content)) return [];

    const events: BrainEvent[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // In non-streaming mode whole messages arrive here rather than as
        // deltas. Emitting them as one delta keeps the UI on a single path.
        this.assistantText += block.text;
        events.push({ type: 'message.delta', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        this.toolNames.set(block.id, name);
        events.push({ type: 'tool.start', toolId: block.id, name, input: block.input ?? {} });
      }
    }
    return events;
  }

  private fromToolResults(line: StreamLine): BrainEvent[] {
    const content = line.message?.content;
    if (!Array.isArray(content)) return [];

    const events: BrainEvent[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result') continue;
      const toolId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const name = this.toolNames.get(toolId) ?? 'unknown';
      const ok = block.is_error !== true;
      const text = extractText(block.content);

      events.push({
        type: 'tool.result',
        toolId,
        name,
        ok,
        summary: ok ? summarize(name, text) : text.slice(0, 200),
      });

      if (ok && MEMORY_TOOL.test(name)) {
        const citations = parseCitations(text);
        if (citations.length > 0) events.push({ type: 'citation', toolId, citations });
      }
    }
    return events;
  }

  private fromResult(line: StreamLine): BrainEvent[] {
    if (typeof line.total_cost_usd === 'number') this.costUsd = line.total_cost_usd;
    if (line.usage) {
      this.inputTokens = line.usage.input_tokens ?? this.inputTokens;
      this.outputTokens = line.usage.output_tokens ?? this.outputTokens;
    }
    if (line.is_error) {
      return [{
        type: 'error',
        code: 'runner_failed',
        message: typeof line.result === 'string' ? line.result : 'the model reported an error',
        retryable: false,
      }];
    }
    // `result` holds the final text. In non-streaming runs it is the only place
    // the answer appears, so take it when nothing arrived as deltas -- but not
    // otherwise, or the UI shows the whole answer twice.
    const events: BrainEvent[] = [];
    if (this.assistantText.length === 0 && typeof line.result === 'string' && line.result.length > 0) {
      this.assistantText = line.result;
      events.push({ type: 'message.delta', text: line.result });
    }
    events.push({
      type: 'message.done',
      conversationId: this.conversationId,
      sessionId: this.sessionId,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens, costUsd: this.costUsd },
      stopReason: this.stopReason,
    });
    return events;
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as Record<string, unknown>;
        return typeof p?.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function summarize(name: string, text: string): string {
  // Some tools return no text at all. An empty summary renders as a chip
  // reading "ToolSearch —", so say the only true thing available instead.
  if (text.trim().length === 0) return 'done';
  if (!MEMORY_TOOL.test(name)) return text.slice(0, 200);
  const matched = /^(\d+) item\(s\) matched/m.exec(text);
  if (matched) return `found ${matched[1]} memories`;
  if (text.startsWith('No memory matched')) return 'no memories matched';
  if (text.startsWith('Stored as')) return 'stored a new memory';
  if (text.startsWith('Already known')) return 'already knew this';
  return text.split('\n')[0]?.slice(0, 120) ?? '';
}

/**
 * Recovers citations from a memory tool's text output.
 *
 * Parsing our own formatted text back into structure is not elegant, and the
 * alternative -- a side channel from MCP to the Gateway -- is worse: it would
 * mean the Gateway had to correlate two streams by tool id and trust that they
 * agreed. The packer's line format is stable and ours, so reading it back is a
 * contract between two files we control.
 */
export function parseCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  const header = /^\[(item_[a-z0-9]+)\]\s*\((\w+),\s*([\d-]+),\s*src=(.*)\)$/gm;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    header.lastIndex = 0;
    const match = header.exec(lines[i]!);
    if (!match) continue;
    const [, id, type, date, source] = match as unknown as [string, string, string, string, string];
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j]!.trim() !== '' && !lines[j]!.startsWith('['); j++) {
      body.push(lines[j]!);
    }
    citations.push({
      id,
      type: type as Citation['type'],
      source,
      timestamp: `${date}T00:00:00.000Z`,
      score: 0,
      ranks: {},
      snippet: body.join(' ').slice(0, 300),
    });
  }
  return citations;
}
