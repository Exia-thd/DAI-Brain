export interface GatewayConfig {
  port: number;
  databaseUrl: string;
  coreUrl: string;
  mcpUrl: string;
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
  writebackEnabled: boolean;
  writebackPollMs: number;
  writebackModel: string;
  writebackMinConfidence: number;
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

  return {
    port: int('GATEWAY_PORT', 8080, env),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/daibrain',
    coreUrl: env.CORE_URL ?? 'http://localhost:8081',
    mcpUrl: env.MCP_URL ?? 'http://localhost:8082/mcp',
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    model: env.CLAUDE_MODEL ?? null,
    maxConcurrency: int('GATEWAY_MAX_CONCURRENCY', 8, env),
    requestTimeoutMs: int('GATEWAY_REQUEST_TIMEOUT_MS', 300_000, env),
    sessionRoot: env.GATEWAY_SESSION_ROOT ?? '/tmp/dai-brain-sessions',
    prefetchTokens: int('GATEWAY_PREFETCH_TOKENS', 1000, env),
    prefetchEnabled: env.GATEWAY_PREFETCH !== 'false',
    jwtSecret: secret,
    devScope,
    uiRoot: env.GATEWAY_UI_ROOT ?? '',
    writebackEnabled: env.GATEWAY_WRITEBACK !== 'false',
    writebackPollMs: int('GATEWAY_WRITEBACK_POLL_MS', 5_000, env),
    writebackModel: env.GATEWAY_WRITEBACK_MODEL ?? 'claude-haiku-4-5-20251001',
    writebackMinConfidence: Number(env.GATEWAY_WRITEBACK_MIN_CONFIDENCE ?? '0.6'),
  };
}
