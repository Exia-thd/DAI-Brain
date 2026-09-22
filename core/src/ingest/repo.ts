import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { MemoryType, WriteItemRequest } from '@dai-brain/shared';

const exec = promisify(execFile);

/**
 * Bootstrapping memory from a repository.
 *
 * The cold-start problem: a fresh store knows nothing, and conversation memory
 * only accumulates by having conversations. A repository already holds months
 * of reasoning -- it is just not in a form anything can retrieve.
 *
 * What this deliberately does *not* do is index code. Symbols, call graphs and
 * file structure are derived data: they go stale on the next commit, and an
 * agent with the repo checked out can read them directly and get today's
 * answer instead of last week's. Re-deriving that into a memory store buys
 * staleness and costs a re-index.
 *
 * What it takes instead is the part of a repository that is *not* recoverable
 * by reading the code: why it is shaped this way. An ADR, a CONTRIBUTING file,
 * the paragraph in a README explaining a choice, a commit message whose body
 * argues for something. None of that is in the syntax tree, and all of it is
 * what someone asks about six months later.
 */

export interface ScanOptions {
  /** Hard ceiling on items produced, so one huge monorepo cannot flood a store. */
  maxItems?: number;
  /** How many commits of history to read. 0 skips git entirely. */
  maxCommits?: number;
  /** Only commits at or after this date, e.g. '2024-01-01'. */
  since?: string;
  /** Below this many characters a section is a fragment, not a memory. */
  minChars?: number;
  maxFileBytes?: number;
}

const DEFAULTS = {
  maxItems: 500,
  maxCommits: 200,
  minChars: 120,
  maxFileBytes: 256 * 1024,
};

/** Directories that hold generated or vendored files, never authored reasoning. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', '.turbo',
  '.cache', 'tmp', '.idea', '.vscode',
]);

/**
 * Files worth reading, in the order of how much they usually carry.
 *
 * Matched against the repo-relative path, lowercased. The list is explicit
 * rather than "every .md": a repo's markdown is mostly generated API docs and
 * changelogs, and ingesting those buries the handful of files that actually
 * explain decisions.
 */
const DOC_PATTERNS: { pattern: RegExp; type: MemoryType; kind: string }[] = [
  // Architecture decision records are the purest form of what this is after.
  { pattern: /(^|\/)(docs?\/)?(adrs?|decisions?|rfcs?)\//, type: 'decision', kind: 'adr' },
  { pattern: /(^|\/)(adr|rfc)[-_]?\d+.*\.mdx?$/, type: 'decision', kind: 'adr' },
  // Conventions: how things are done here.
  { pattern: /(^|\/)(contributing|conventions?|style[-_]?guide)\.mdx?$/, type: 'procedure', kind: 'conventions' },
  { pattern: /(^|\/)(claude|agents?|cursor)\.mdx?$/, type: 'preference', kind: 'agent-instructions' },
  { pattern: /(^|\/)\.(claude|cursor)\/.*\.mdx?$/, type: 'preference', kind: 'agent-instructions' },
  // Architecture and design prose.
  { pattern: /(^|\/)(architecture|design|overview|rationale)\.mdx?$/, type: 'decision', kind: 'architecture' },
  { pattern: /(^|\/)docs?\/.*\.mdx?$/, type: 'artifact', kind: 'docs' },
  // A README is mostly description, so it lands on the lowest-weight type and
  // is promoted per-section only when the prose actually argues for something.
  { pattern: /(^|\/)readme[^/]*\.mdx?$/, type: 'artifact', kind: 'readme' },
];

/** Prose that argues rather than describes. Promotes a section to `decision`. */
const DECISION_LANGUAGE = new RegExp(
  [
    'we (chose|picked|decided|settled|went with|use|prefer)',
    '(instead of|rather than|as opposed to)',
    '(because|the reason|which is why|on purpose|deliberately|by design)',
    '(trade[- ]?off|we rejected|we considered|not worth)',
    // Vietnamese, since this store holds both.
    '(quy[eế]t đ[iị]nh|l[yý] do|thay v[iì]|b[oở]i v[iì]|ch[uọ]n)',
  ].join('|'),
  'i',
);

export interface Section {
  /** "Retrieval > Token budget packer" — so the memory reads standalone. */
  breadcrumb: string;
  body: string;
}

/**
 * Splits markdown into one section per heading.
 *
 * A section is the natural unit of a decision: one heading, one idea. The
 * breadcrumb carries the heading stack into the memory itself, because a
 * retrieved memory arrives without the document around it -- "Token budget
 * packer" alone means nothing, and it is the one thing the reader cannot
 * reconstruct.
 *
 * Fenced code blocks are tracked so a `#` comment inside bash never looks
 * like a heading and cuts a section in half.
 */
export function sections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const stack: string[] = [];
  const out: Section[] = [];
  let heading: string[] = [];
  let body: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = body.join('\n').trim();
    if (text.length > 0) out.push({ breadcrumb: heading.join(' > '), body: text });
    body = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      body.push(line);
      continue;
    }
    if (fence !== null) { body.push(line); continue; }

    const headingMatch = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (!headingMatch) { body.push(line); continue; }

    flush();
    const level = headingMatch[1]!.length;
    const title = headingMatch[2]!.replace(/\s*#+\s*$/, '');
    stack.length = Math.max(0, level - 1);
    stack[level - 1] = title;
    heading = stack.filter(Boolean);
  }
  flush();
  return out;
}

function classify(baseType: MemoryType, section: Section): MemoryType {
  // A README section that argues for a choice is a decision, whatever the file
  // it lives in; a decision file's section that merely lists options is not
  // demoted, because the file's intent is the stronger signal.
  if (baseType === 'artifact' && DECISION_LANGUAGE.test(section.body)) return 'decision';
  return baseType;
}

/**
 * Entity candidates: backticked identifiers, plus the file's own name.
 *
 * Deliberately narrow. A looser rule (every capitalised phrase) produces a
 * graph where everything connects to everything, and a graph branch that
 * matches every query is the same as no graph branch at all.
 */
export function entitiesOf(section: Section, relPath: string): { name: string; kind: string }[] {
  const names = new Map<string, string>();

  // The optional `()` matters: prose names functions as `scopeWhere()` far more
  // often than as `scopeWhere`, and without it the whole backtick fails to
  // match, so exactly the identifiers most worth linking are the ones missed.
  for (const match of section.body.matchAll(/`([A-Za-z][\w./-]{2,40})(?:\(\))?`/g)) {
    const raw = match[1]!;
    // A path or a sentence fragment in backticks is not an entity.
    if (raw.includes(' ') || raw.split('/').length > 2) continue;
    names.set(raw, 'identifier');
  }

  const file = basename(relPath, extname(relPath));
  if (file.length > 2 && !/^(readme|index)$/i.test(file)) {
    names.set(file, 'document');
  }
  // The heading is what the section is *about*, which is the best single
  // entity available and the one a later question is most likely to name.
  const leaf = section.breadcrumb.split(' > ').pop();
  if (leaf && leaf.length > 2 && leaf.length < 60) names.set(leaf, 'topic');

  return [...names].slice(0, 10).map(([name, kind]) => ({ name, kind }));
}

async function walk(root: string, dir: string, found: string[], limit: number): Promise<void> {
  if (found.length >= limit) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // An unreadable directory is not a reason to abandon the scan.
  }
  for (const entry of entries) {
    if (found.length >= limit) return;
    if (entry.name.startsWith('.') && !/^\.(claude|cursor|github)$/i.test(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(root, full, found, limit);
    } else if (/\.mdx?$/i.test(entry.name)) {
      found.push(full);
    }
  }
}

export interface RepoItem extends WriteItemRequest {
  /** Where it came from, for the dry-run listing. */
  origin: string;
}

export async function scanDocs(root: string, options: ScanOptions = {}): Promise<RepoItem[]> {
  const maxItems = options.maxItems ?? DEFAULTS.maxItems;
  const minChars = options.minChars ?? DEFAULTS.minChars;
  const maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes;

  const files: string[] = [];
  await walk(root, root, files, maxItems * 4);

  const items: RepoItem[] = [];
  for (const file of files) {
    if (items.length >= maxItems) break;
    const rel = relative(root, file).split(sep).join('/');
    const match = DOC_PATTERNS.find((p) => p.pattern.test(rel.toLowerCase()));
    if (!match) continue;

    try {
      const info = await stat(file);
      if (info.size > maxFileBytes) continue;
    } catch { continue; }

    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch { continue; }

    for (const section of sections(text)) {
      if (items.length >= maxItems) break;
      if (section.body.length < minChars) continue;
      // A section that is only a code fence carries no reasoning; the code is
      // already in the repo and reads better there.
      if (section.body.replace(/```[\s\S]*?```/g, '').trim().length < minChars / 2) continue;

      const heading = section.breadcrumb || basename(rel);
      items.push({
        type: classify(match.type, section),
        content: `${heading}\n\n${section.body}`,
        // Traceable back to the exact section. A memory you cannot check is a
        // memory you cannot trust six months from now.
        source: `repo:${rel}#${slug(heading)}`,
        confidence: 0.9,
        entities: entitiesOf(section, rel),
        origin: `${rel} — ${heading}`,
      });
    }
  }
  return items;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
  date: string;
}

/**
 * Commits whose message argues for something.
 *
 * Most commit subjects are labels ("fix typo", "bump deps") and carry nothing
 * worth retrieving. A commit with a body is someone taking the trouble to
 * explain, which is exactly the reasoning that exists nowhere else in the
 * repository -- not in the diff, and not in the code the diff produced.
 */
export async function scanCommits(root: string, options: ScanOptions = {}): Promise<RepoItem[]> {
  const maxCommits = options.maxCommits ?? DEFAULTS.maxCommits;
  if (maxCommits <= 0) return [];

  const args = [
    '-C', root, 'log', '--no-merges',
    `--max-count=${maxCommits}`,
    '--format=%H%x1f%s%x1f%b%x1f%aI%x1e',
  ];
  if (options.since) args.push(`--since=${options.since}`);

  let stdout: string;
  try {
    ({ stdout } = await exec('git', args, { maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return []; // Not a git repo, or no git. Docs are still worth having.
  }

  const items: RepoItem[] = [];
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, subject, body, date] = trimmed.split('\x1f');
    if (!sha || !subject) continue;

    const message = (body ?? '')
      // Trailers are metadata, not reasoning, and they would otherwise make
      // every commit look similar to every other one to the embedder.
      .replace(/^(Co-Authored-By|Signed-off-by|Claude-Session|Reviewed-by):.*$/gim, '')
      .trim();
    if (message.length < (options.minChars ?? DEFAULTS.minChars)) continue;

    items.push({
      type: DECISION_LANGUAGE.test(message) ? 'decision' : 'note',
      content: `${subject}\n\n${message}`,
      source: `git:${sha.slice(0, 12)}`,
      confidence: 0.85,
      entities: entitiesOf({ breadcrumb: '', body: message }, 'commit'),
      origin: `${sha.slice(0, 8)} ${subject.slice(0, 60)}`,
    });
  }
  return items;
}

export async function scanRepo(root: string, options: ScanOptions = {}): Promise<RepoItem[]> {
  const [docs, commits] = await Promise.all([
    scanDocs(root, options),
    scanCommits(root, options),
  ]);
  const maxItems = options.maxItems ?? DEFAULTS.maxItems;
  return [...docs, ...commits].slice(0, maxItems);
}
