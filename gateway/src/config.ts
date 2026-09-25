import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GatewayConfig {
  port: number;
  /**
   * Postgres, or null for the personal setup.
   *
   * Null is not a degraded mode. Shared Postgres is what lets the Gateway run
   * more than one instance over one person's memory; one person on one machine
   * has no second instance, so it would be a server running for nobody.
   */
  databaseUrl: string | null;
  /** Local conversation store, used when databaseUrl is null. */
  sqlitePath: string;
  /** Brain Core, or null when memory comes from an MCP server instead. */
  coreUrl: string | null;
  /** Brain MCP, or null when the runner gets its memory tools from elsewhere. */
  mcpUrl: string | null;
  /** Path to the `claude` binary. */
  claudeBin: string;
  model: string | null;
  /** Concurrent runner processes. Each is a whole CLI; this is not a large number. */
  maxConcurrency: number;
  requestTimeoutMs: number;
  /** Where per-session working directories live. */
  sessionRoot: string;
  /**
   * The directory every turn runs in, when one is pinned.
   *
   * Null gives each conversation its own scratch directory, which is right
   * when several people share a Gateway. It is wrong for a personal window
   * over a file-backed memory server: the DAI Memory plugin finds its store by
   * walking up from the working directory, so a scratch directory means it
   * finds nothing and reports the store as missing.
   */
  projectDir: string | null;
  /** Token budget for the pre-fetch injected into --append-system-prompt. */
  prefetchTokens: number;
  prefetchEnabled: boolean;
  jwtSecret: string;
  /** Skips JWT verification and uses a fixed scope. Local development only. */
  devScope: string | null;
  uiRoot: string;
  /**
   * Extra MCP servers to give the runner, as a path to a JSON file the
   * operator wrote. Never per-request: a web user naming an MCP server is a
   * web user choosing what the agent may reach.
   */
  extraMcpConfigPath: string | null;
  /** Tool names from those servers the model may call. Explicit, so it audits. */
  extraAllowedTools: string[];
  /**
   * Tools the model may not call, whatever else it is offered.
   *
   * `--allowedTools` turned out to be an allow list for tools that would
   * otherwise prompt, not a fence around everything else: a turn observed here
   * called `Read` without it being listed. That is reasonable in a personal
   * window pointed at your own project, and not reasonable at all for anything
   * that writes or executes — so those are refused by name.
   */
  disallowedTools: string[];
  writebackEnabled: boolean;
  writebackPollMs: number;
  writebackModel: string;
  writebackMinConfidence: number;
  /**
   * What one conversation may spend before the Gateway stops answering it.
   *
   * Zero disables the check. It is not zero by default: a Gateway that spawns
   * a billable subprocess per message with nothing watching is a runaway loop
   * away from an empty account, and the person who finds out is the one paying.
   */
  maxConversationCostUsd: number;
  /**
   * Slash commands, as a JSON object of name -> argv.
   *
   * Operator configuration, never anything a message can reach: a chat message
   * chooses which entry runs and supplies nothing to it.
   */
  commands: string;
  /** How many files may ride along with one message. */
  maxAttachments: number;
  /** Total decoded bytes of those files. Base64 in a JSON body is not free. */
  maxAttachmentBytes: number;
  /**
   * Whether each session gets its own CLAUDE_CONFIG_DIR.
   *
   * Isolation is right when the runner authenticates from the environment: one
   * person's login, history and settings must not become the next person's.
   * It is wrong when there is no API key, because then the CLI's own login IS
   * the credential, and handing it an empty directory means handing it nothing
   * — which surfaces as "Invalid API key · Please run /login" and looks like a
   * key problem rather than a config-directory one.
   */
  isolateClaudeConfig: boolean;
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer (got ${raw})`);
  return n;
}

export function loadGatewayConfig(env = process.env): GatewayConfig {
  const devScope = env.GATEWAY_DEV_SCOPE ?? null;
  const secret = env.GATEWAY_JWT_SECRET ?? '';
  if (!secret && !devScope) {
    // Refusing to boot is the right failure. A gateway that starts without a
    // secret starts with authentication that cannot work, and the first sign
    // would be every request being rejected -- or worse, not being.
    throw new Error(
      'GATEWAY_JWT_SECRET is required. For local development without auth, set '
      + 'GATEWAY_DEV_SCOPE=tenant/user/project instead — it is refused when NODE_ENV=production.',
    );
  }
  if (devScope && env.NODE_ENV === 'production') {
    throw new Error('GATEWAY_DEV_SCOPE must not be set in production: it disables authentication.');
  }

  const sessionRoot = env.GATEWAY_SESSION_ROOT ?? join(tmpdir(), 'dai-brain-sessions');
  // 'none' rather than only the empty string: an operator turning Core off in a
  // .env file writes a word, and an empty value reads as "not set yet".
  const coreUrl = env.CORE_URL === 'none' || env.CORE_URL === ''
    ? null
    : env.CORE_URL ?? (env.DATABASE_URL ? 'http://localhost:8081' : null);

  return {
    port: int('GATEWAY_PORT', 8080, env),
    databaseUrl: env.DATABASE_URL || null,
    sqlitePath: env.GATEWAY_SQLITE_PATH ?? join(sessionRoot, 'conversations.db'),
    coreUrl,
    // Tied to Core, because Brain MCP is a front for it: declaring a server
    // that is not running does worse than nothing. The model sees the
    // connection fail and starts discounting whatever memory it does get.
    mcpUrl: env.MCP_URL === 'none' || env.MCP_URL === ''
      ? null
      : env.MCP_URL ?? (coreUrl ? 'http://localhost:8082/mcp' : null),
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    model: env.CLAUDE_MODEL ?? null,
    maxConcurrency: int('GATEWAY_MAX_CONCURRENCY', 8, env),
    requestTimeoutMs: int('GATEWAY_REQUEST_TIMEOUT_MS', 300_000, env),
    sessionRoot,
    projectDir: env.GATEWAY_PROJECT_DIR || null,
    prefetchTokens: int('GATEWAY_PREFETCH_TOKENS', 1000, env),
    prefetchEnabled: env.GATEWAY_PREFETCH !== 'false',
    jwtSecret: secret,
    devScope,
    uiRoot: env.GATEWAY_UI_ROOT ?? '',
    extraMcpConfigPath: env.GATEWAY_EXTRA_MCP_CONFIG || null,
    extraAllowedTools: (env.GATEWAY_EXTRA_ALLOWED_TOOLS ?? '')
      .split(',').map((t) => t.trim()).filter(Boolean),
    disallowedTools: (env.GATEWAY_DISALLOWED_TOOLS
      // Reading is useful and the project is the person's own. Writing and
      // executing are not what a chat window is for.
      ?? 'Bash,Write,Edit,MultiEdit,NotebookEdit,KillShell')
      .split(',').map((t) => t.trim()).filter(Boolean),
    // Write-back needs Core to reconcile into and a queue to sit in, so it is
    // off by default in the personal setup rather than failing every turn.
    writebackEnabled: env.GATEWAY_WRITEBACK !== 'false' && coreUrl !== null && Boolean(env.DATABASE_URL),
    writebackPollMs: int('GATEWAY_WRITEBACK_POLL_MS', 5_000, env),
    writebackModel: env.GATEWAY_WRITEBACK_MODEL ?? 'claude-haiku-4-5-20251001',
    writebackMinConfidence: Number(env.GATEWAY_WRITEBACK_MIN_CONFIDENCE ?? '0.6'),
    maxConversationCostUsd: Number(env.GATEWAY_MAX_CONVERSATION_COST_USD ?? '5'),
    // 5 MB decoded, which is about 6.7 MB of base64, which fits under the
    // router's 8 MB body cap with room for the message. Set above that and the
    // limit becomes unreachable: the router refuses the request first, with
    // `request body too large` instead of a message naming attachments.
    commands: env.GATEWAY_COMMANDS ?? '',
    maxAttachments: int('GATEWAY_MAX_ATTACHMENTS', 10, env),
    maxAttachmentBytes: int('GATEWAY_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024, env),
    isolateClaudeConfig: env.GATEWAY_ISOLATE_CLAUDE_CONFIG
      ? env.GATEWAY_ISOLATE_CLAUDE_CONFIG !== 'false'
      : Boolean(env.ANTHROPIC_API_KEY),
  };
}
