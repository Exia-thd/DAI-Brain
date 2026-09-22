import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SCOPE_HEADER, formatScopeHeader } from '@dai-brain/shared';
import type { GatewayConfig } from '../config.js';
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
 * Runs one turn by spawning `claude -p`.
 *
 * The flags are the contract:
 *   --output-format stream-json --verbose   one JSON object per line, streamed
 *   --mcp-config --strict-mcp-config        exactly our memory server, nothing
 *                                           the user's own config might add
 *   --allowedTools                          only the four memory tools, so a
 *                                           prompt cannot talk the model into
 *                                           reading the host filesystem
 *   --append-system-prompt                  the pre-fetched core context
 *   --resume                                continue the same Claude session
 *
 * `--strict-mcp-config` is the load-bearing one. Without it the CLI merges the
 * machine's own MCP servers into a session serving a web user, which is a hole
 * that does not announce itself.
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
        'mcp__memory__memory_search,mcp__memory__memory_graph_explore,mcp__memory__memory_get,mcp__memory__memory_write',
        '--append-system-prompt', request.systemPrompt,
      ];
      if (this.config.model) args.push('--model', this.config.model);
      if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);

      const proc: RunnerChild = spawn(this.config.claudeBin, args, {
        cwd: request.workdir,
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
        throw new RunnerError(
          `claude exited with code ${code}: ${stderr.join('').trim().slice(-800) || '(no stderr)'}`,
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
    // A config directory per session, so one user's login state, history and
    // settings are not the next user's.
    env.CLAUDE_CONFIG_DIR = configDir;
    return env;
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

  private async writeMcpConfig(request: RunRequest, configDir: string): Promise<string> {
    const path = join(configDir, 'mcp.json');
    await writeFile(path, JSON.stringify({
      mcpServers: {
        // The server name decides the tool prefix the model sees
        // (mcp__memory__memory_search), which is also what --allowedTools and
        // the stream translator match on. Changing it means changing all three.
        memory: {
          type: 'http',
          url: this.config.mcpUrl,
          headers: {
            // The scope the Gateway decided, travelling to MCP and on to Core.
            // The model never sees this header and cannot change it.
            [SCOPE_HEADER]: formatScopeHeader(request.scope),
          },
        },
      },
    }, null, 2), 'utf8');
    return path;
  }
}
