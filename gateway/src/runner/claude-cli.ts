import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SCOPE_HEADER, formatScopeHeader } from '@dai-brain/shared';
import type { GatewayConfig } from '../config.js';
import { resolveRunner } from './resolve.js';
import type { Semaphore } from './semaphore.js';
import type { RunRequest, Runner, StreamLine } from './types.js';

export class RunnerError extends Error {
  override readonly name = 'RunnerError';
  constructor(message: string, readonly code: 'timeout' | 'cancelled' | 'spawn_failed' | 'exited') {
    super(message);
  }
}

/** SIGTERM first, then SIGKILL if the process is still there. */
const KILL_GRACE_MS = 3_000;

/** stdin is 'ignore': the prompt goes in as an argument, nothing is piped in. */
type RunnerChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * The memory tools, always allowed.
 *
 * The server is named `memory`, which is what sets this prefix, what
 * --allowedTools matches, and what the stream translator keys citations off.
 * Changing the name means changing all three.
 */
const MEMORY_TOOLS = [
  'mcp__memory__memory_search',
  'mcp__memory__memory_graph_explore',
  'mcp__memory__memory_get',
  'mcp__memory__memory_write',
];

/** Brain MCP's entry, omitted entirely when there is no Brain MCP to reach. */
function memoryServer(url: string, scope: Parameters<typeof formatScopeHeader>[0]) {
  return {
    memory: {
      type: 'http',
      url,
      headers: {
        // The scope the Gateway decided, travelling to MCP and on to Core.
        // The model never sees this header and cannot change it.
        [SCOPE_HEADER]: formatScopeHeader(scope),
      },
    },
  };
}

type McpServers = Record<string, unknown>;

/**
 * Runs one turn by spawning `claude -p`.
 *
 * The flags are the contract:
 *   --output-format stream-json --verbose   one JSON object per line, streamed
 *   --mcp-config --strict-mcp-config        exactly the servers the operator
 *                                           chose, never whatever the host
 *                                           machine happens to have configured
 *   --allowedTools                          only the four memory tools, so a
 *                                           prompt cannot talk the model into
 *                                           reading the host filesystem
 *   --append-system-prompt                  the pre-fetched core context
 *   --resume                                continue the same Claude session
 *
 * `--strict-mcp-config` is the load-bearing one. Without it the CLI merges the
 * machine's own MCP servers into a session serving a web user, which is a hole
 * that does not announce itself. It has never meant "memory only" -- it means
 * the operator decides, so extra servers arrive through
 * GATEWAY_EXTRA_MCP_CONFIG and their tools through GATEWAY_EXTRA_ALLOWED_TOOLS,
 * rather than by whatever a developer once ran `claude mcp add` for.
 */
export class ClaudeCliRunner implements Runner {
  readonly name = 'claude-cli';

  constructor(
    private readonly config: GatewayConfig,
    private readonly semaphore: Semaphore,
  ) {}

  async *run(request: RunRequest): AsyncIterable<StreamLine> {
    const release = await this.semaphore.acquire(request.signal);
    let child: RunnerChild | null = null;
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;

    try {
      await mkdir(request.workdir, { recursive: true });
      const configDir = join(request.workdir, '.claude-config');
      await mkdir(configDir, { recursive: true });
      const mcpConfigPath = await this.writeMcpConfig(request, configDir);

      const args = [
        '-p', request.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
        '--allowedTools',
        [
          ...(this.config.mcpUrl ? MEMORY_TOOLS : []),
          ...this.config.extraAllowedTools,
        ].join(','),
        '--append-system-prompt', request.systemPrompt,
      ];
      if (this.config.disallowedTools.length > 0) {
        args.push('--disallowedTools', this.config.disallowedTools.join(','));
      }
      for (const dir of request.addDirs) args.push('--add-dir', dir);
      if (this.config.model) args.push('--model', this.config.model);
      if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);

      // Windows cannot spawn the .cmd shim, and a shell is out of the
      // question with a user's prompt in argv. See resolveRunner.
      const runner = resolveRunner(this.config.claudeBin);
      const proc: RunnerChild = spawn(runner.command, [...runner.prefixArgs, ...args], {
        // A pinned project directory when there is one: a file-backed memory
        // server finds its store by walking up from here, and a per-session
        // scratch directory puts it somewhere that store is not.
        cwd: this.config.projectDir ?? request.workdir,
        env: this.childEnv(configDir),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;

      const stderr: string[] = [];
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk.toString('utf8'));
        // Bounded: a runaway process must not be able to fill the Gateway's
        // heap with its own error output.
        if (stderr.length > 200) stderr.splice(0, 100);
      });

      const spawnFailed = new Promise<never>((_, reject) => {
        proc.once('error', (err) => reject(
          new RunnerError(
            `could not start ${this.config.claudeBin}: ${err.message}. `
            + 'Set CLAUDE_BIN to the CLI path, or install it with `npm i -g @anthropic-ai/claude-code`.',
            'spawn_failed',
          ),
        ));
      });
      // An unobserved rejection here would be an unhandled rejection the moment
      // the happy path finishes first.
      spawnFailed.catch(() => {});

      const kill = (reason: 'timeout' | 'cancelled') => {
        if (reason === 'timeout') timedOut = true;
        this.terminate(proc);
      };
      timer = setTimeout(() => kill('timeout'), this.config.requestTimeoutMs);
      request.signal.addEventListener('abort', () => kill('cancelled'), { once: true });

      const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      const exited = new Promise<number | null>((resolve) => {
        proc.once('close', (code) => resolve(code));
      });

      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed: StreamLine;
        try {
          parsed = JSON.parse(trimmed) as StreamLine;
        } catch {
          // The CLI sometimes writes a non-JSON notice to stdout. Dropping it
          // is better than ending a working stream over a line we did not need.
          continue;
        }
        yield parsed;
      }

      const code = await Promise.race([exited, spawnFailed]);
      if (timedOut) {
        throw new RunnerError(
          `the model did not finish within ${this.config.requestTimeoutMs}ms`,
          'timeout',
        );
      }
      if (request.signal.aborted) throw new RunnerError('client disconnected', 'cancelled');
      if (code !== 0 && code !== null) {
        const detail = stderr.join('').trim().slice(-800);
        throw new RunnerError(
          `claude exited with code ${code}: ${detail || '(no stderr)'}${this.authHint(code, detail)}`,
          'exited',
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.terminate(child);
      release();
    }
  }

  /**
   * The child's environment, built rather than inherited.
   *
   * Inheriting the Gateway's whole environment sounds harmless and is not. Any
   * CLAUDE_* variable set on the host becomes configuration for every user's
   * session: one host's debug flag, telemetry setting, or -- as this was found
   * by -- its own session id, which the child then reports as the session to
   * resume. Binding that to a conversation would point several conversations at
   * one Claude session and merge their histories.
   *
   * So the CLAUDE_* namespace is dropped and re-established deliberately. The
   * credential is passed explicitly, because the runner does have to
   * authenticate; everything else a user's session needs, it gets from flags.
   */
  private childEnv(configDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('CLAUDE_')) continue;
      env[key] = value;
    }
    if (this.config.isolateClaudeConfig) {
      // A config directory per session, so one user's login state, history and
      // settings are not the next user's. Only safe when the credential comes
      // from the environment instead.
      env.CLAUDE_CONFIG_DIR = configDir;
    } else if (process.env.CLAUDE_CONFIG_DIR) {
      // Stripped with the rest of the CLAUDE_* namespace above, so it has to be
      // put back deliberately: without an API key this directory holds the only
      // credential there is.
      env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    }
    return env;
  }

  /**
   * Turns an authentication failure into something the operator can act on.
   *
   * The CLI reports a missing login as "Invalid API key", which sends people
   * looking for a key problem. The likelier cause here is that the Gateway
   * pointed the CLI at a config directory with no login in it.
   */
  private authHint(code: number | null, detail: string): string {
    if (code !== 1) return '';
    const looksLikeAuth = detail === '' || /invalid api key|\/login|unauthor/i.test(detail);
    if (!looksLikeAuth) return '';
    if (this.config.isolateClaudeConfig) {
      return '\n  The runner has its own CLAUDE_CONFIG_DIR, so it cannot use your `claude` login. '
        + 'Set ANTHROPIC_API_KEY, or set GATEWAY_ISOLATE_CLAUDE_CONFIG=false to reuse your own login.';
    }
    return '\n  The runner is using your own `claude` login. Run `claude` once and sign in, '
      + 'or set ANTHROPIC_API_KEY.';
  }

  /**
   * Ends the process, and means it.
   *
   * SIGTERM lets the CLI close its MCP connections; SIGKILL after a grace
   * period covers the case where it does not. A gateway that only ever sends
   * SIGTERM leaks a process per hung request, and the leak is invisible until
   * the semaphore is full of processes nobody is waiting for.
   */
  private terminate(child: RunnerChild | null): void {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    timer.unref();
  }

  /**
   * Extra MCP servers, read once from a file the operator wrote.
   *
   * Cached because it is deployment configuration, not per-request input, and
   * re-reading it on every turn would let a mid-flight edit hand two
   * concurrent conversations different tool sets.
   *
   * A failure here is loud rather than silent. An operator who configured Jira
   * and got a session with no Jira would debug the prompt for an hour before
   * suspecting the config file.
   */
  private async extraServers(): Promise<McpServers> {
    if (!this.config.extraMcpConfigPath) return {};
    if (this.extraCache) return this.extraCache;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.config.extraMcpConfigPath, 'utf8'));
    } catch (err) {
      throw new RunnerError(
        `GATEWAY_EXTRA_MCP_CONFIG (${this.config.extraMcpConfigPath}) could not be read: `
        + `${(err as Error).message}`,
        'spawn_failed',
      );
    }

    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      throw new RunnerError(
        `GATEWAY_EXTRA_MCP_CONFIG (${this.config.extraMcpConfigPath}) must be `
        + '{"mcpServers": { ... }}',
        'spawn_failed',
      );
    }

    this.extraCache = servers as McpServers;
    return this.extraCache;
  }

  private extraCache: McpServers | null = null;

  private async writeMcpConfig(request: RunRequest, configDir: string): Promise<string> {
    const path = join(configDir, 'mcp.json');
    const extra = await this.extraServers();

    await writeFile(path, JSON.stringify({
      mcpServers: {
        // Extra servers first, so `memory` below cannot be shadowed. Letting a
        // config file redefine it would point the memory tools at somebody
        // else's endpoint -- which would be handed this user's scope header on
        // the next search.
        ...extra,
        ...(this.config.mcpUrl ? memoryServer(this.config.mcpUrl, request.scope) : {}),
      },
    }, null, 2), 'utf8');
    return path;
  }
}
