import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * How to actually start the Claude CLI on this platform.
 *
 * On Linux and macOS `claude` is an executable and this is a no-op. On Windows
 * it is `claude.cmd`, a batch shim -- and since the fix for CVE-2024-27980,
 * Node refuses to spawn a `.cmd` without `shell: true`.
 *
 * `shell: true` is not an option here, and the reason is worth stating plainly:
 * the prompt is whatever the user typed, passed as an argument. Under a shell
 * those arguments are re-parsed by cmd.exe, so a message containing `& del ...`
 * stops being text and becomes a command. Convenience is not worth handing the
 * shell a stranger's sentence.
 *
 * So the shim is stepped over instead: find the JavaScript entry point behind
 * it and run that with this process's own Node, which needs no shell and
 * re-parses nothing.
 */
export interface ResolvedRunner {
  command: string;
  /** Arguments that must come before the CLI's own. Empty off Windows. */
  prefixArgs: string[];
}

const CLI_ENTRY = join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

export function resolveRunner(
  claudeBin: string,
  platform: NodeJS.Platform = process.platform,
  execPath = process.execPath,
): ResolvedRunner {
  // An explicit JS entry point, on any platform: run it with Node directly.
  // This is also the escape hatch when the search below cannot find one.
  if (/\.[cm]?js$/i.test(claudeBin)) {
    return { command: execPath, prefixArgs: [claudeBin] };
  }
  if (platform !== 'win32') {
    return { command: claudeBin, prefixArgs: [] };
  }

  const entry = findWindowsEntry(claudeBin);
  if (entry) return { command: execPath, prefixArgs: [entry] };

  throw new Error(
    `Cannot start the Claude CLI on Windows from ${JSON.stringify(claudeBin)}. `
    + 'Node cannot spawn a .cmd shim, and running it through a shell would let a '
    + "user's message reach cmd.exe as a command. Set CLAUDE_BIN to the CLI's "
    + 'JavaScript entry point instead, for example:\r\n'
    + `  set CLAUDE_BIN=%APPDATA%\\npm\\${CLI_ENTRY}\r\n`
    + 'Find it with: npm root -g',
  );
}

/** Looks for the shim on PATH, then for the real entry point beside it. */
function findWindowsEntry(claudeBin: string): string | null {
  const candidates: string[] = [];

  const dirs = claudeBin.includes('\\') || claudeBin.includes('/')
    ? [dirname(claudeBin)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    // npm puts the shim and node_modules side by side in the global prefix.
    candidates.push(join(dir, CLI_ENTRY));
    candidates.push(join(dir, '..', CLI_ENTRY));
  }
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', CLI_ENTRY));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* an unreadable PATH entry is not a reason to stop looking */ }
  }
  return null;
}
