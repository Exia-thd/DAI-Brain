import { spawn } from 'node:child_process';
import { MEMORY_TYPES, type MemoryType, type TranscriptTurn } from '@dai-brain/shared';

export interface ExtractedFact {
  type: MemoryType;
  content: string;
  confidence: number;
  entities: { name: string; kind?: string }[];
}

const EXTRACTION_PROMPT = `You are extracting durable memories from a conversation transcript.

Return ONLY a JSON object, no prose, no markdown fence, in exactly this shape:
{"facts":[{"type":"decision","content":"...","confidence":0.9,"entities":[{"name":"...","kind":"component"}]}]}

Rules:
- type is one of: decision, fact, preference, procedure, note, artifact.
- content must stand alone. Someone reading it in six months, without this
  transcript, must understand it completely. Write "We chose X over Y because Z",
  never "we decided on that".
- One idea per fact. Two decisions in one entry cannot be revised independently.
- confidence 0-1. Use 0.9+ only when the user stated it directly. Use 0.6-0.8
  when you inferred it. Below 0.6, leave it out entirely.
- Extract only what will still matter next month. Not the task at hand, not
  pleasantries, not your own suggestions the user did not accept.
- Never include credentials, tokens, keys, or personal data.
- Entities are the named things a memory is about: components, technologies,
  people, projects.
- If there is nothing durable, return {"facts":[]}. An empty answer is correct
  far more often than a padded one.

Transcript:
`;

export interface ExtractorOptions {
  claudeBin: string;
  model: string;
  timeoutMs?: number;
  maxTranscriptChars?: number;
}

export class ExtractionError extends Error {
  override readonly name = 'ExtractionError';
}

/**
 * Extracts candidate memories with a cheap model.
 *
 * A cheap model because this runs on every conversation and the task is
 * closer to structured reading than to reasoning. The prompt asks for JSON
 * and the parser assumes nothing: a model that returns prose, a fence, or a
 * malformed entry must not be able to poison the store or crash the worker.
 */
export async function extractFacts(
  turns: TranscriptTurn[],
  options: ExtractorOptions,
): Promise<ExtractedFact[]> {
  const maxChars = options.maxTranscriptChars ?? 60_000;
  let transcript = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');
  if (transcript.length > maxChars) {
    // Keep the end: a conversation's conclusions are at the bottom, and the
    // opening is usually the part that was superseded by the rest of it.
    transcript = `[…earlier turns omitted…]\n\n${transcript.slice(-maxChars)}`;
  }

  const raw = await runClaude(`${EXTRACTION_PROMPT}${transcript}`, options);
  return parseFacts(raw);
}

export function parseFacts(raw: string): ExtractedFact[] {
  const json = extractJsonObject(raw);
  if (!json) throw new ExtractionError(`extractor returned no JSON object: ${raw.slice(0, 200)}`);

  let parsed: { facts?: unknown };
  try {
    parsed = JSON.parse(json) as { facts?: unknown };
  } catch (err) {
    throw new ExtractionError(`extractor returned invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.facts)) return [];

  const facts: ExtractedFact[] = [];
  for (const candidate of parsed.facts) {
    // `null`, a string, a number: a model asked for an array of objects can
    // return an array containing any of them, and this parser exists precisely
    // to survive that rather than to assume it away.
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    const type = row.type as MemoryType;
    const content = typeof row.content === 'string' ? row.content.trim() : '';
    // Silently dropping a malformed entry rather than failing the batch: one
    // bad row out of ten should cost one memory, not nine.
    if (!MEMORY_TYPES.includes(type) || content.length < 8) continue;

    const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? Math.min(1, Math.max(0, row.confidence))
      : 0.7;

    const entities = Array.isArray(row.entities)
      ? (row.entities as Record<string, unknown>[])
          .map((e) => ({
            name: typeof e?.name === 'string' ? e.name.trim() : '',
            kind: typeof e?.kind === 'string' ? e.kind : undefined,
          }))
          .filter((e) => e.name.length > 0)
          .slice(0, 12)
      : [];

    facts.push({ type, content, confidence, entities });
  }
  return facts;
}

/** Finds the outermost JSON object, tolerating a fence or a sentence around it. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function runClaude(prompt: string, options: ExtractorOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.claudeBin, [
      '-p', prompt,
      '--output-format', 'text',
      '--model', options.model,
      // The extractor reads a transcript and writes JSON. It has no business
      // touching the filesystem or calling memory tools, so it gets neither.
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', '',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => err.push(c.toString('utf8')));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ExtractionError(`extractor timed out after ${options.timeoutMs ?? 120_000}ms`));
    }, options.timeoutMs ?? 120_000);

    child.once('error', (e) => {
      clearTimeout(timer);
      reject(new ExtractionError(`could not run ${options.claudeBin}: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.join(''));
      else reject(new ExtractionError(`extractor exited ${code}: ${err.join('').slice(-500)}`));
    });
  });
}
