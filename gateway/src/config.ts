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
    prefetchTokens: int('GATEWAY_PREFETCH_TOKENS', 1000, env),
    prefetchEnabled: env.GATEWAY_PREFETCH !== 'false',
    jwtSecret: secret,
    devScope,
    uiRoot: env.GATEWAY_UI_ROOT ?? '',
    extraMcpConfigPath: env.GATEWAY_EXTRA_MCP_CONFIG || null,
    extraAllowedTools: (env.GATEWAY_EXTRA_ALLOWED_TOOLS ?? '')
      .split(',').map((t) => t.trim()).filter(Boolean),
    // Write-back needs Core to reconcile into and a queue to sit in, so it is
    // off by default in the personal setup rather than failing every turn.
    writebackEnabled: env.GATEWAY_WRITEBACK !== 'false' && coreUrl !== null && Boolean(env.DATABASE_URL),
    writebackPollMs: int('GATEWAY_WRITEBACK_POLL_MS', 5_000, env),
    writebackModel: env.GATEWAY_WRITEBACK_MODEL ?? 'claude-haiku-4-5-20251001',
    writebackMinConfidence: Number(env.GATEWAY_WRITEBACK_MIN_CONFIDENCE ?? '0.6'),
    maxConversationCostUsd: Number(env.GATEWAY_MAX_CONVERSATION_COST_USD ?? '5'),
  };
}
