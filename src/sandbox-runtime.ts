/**
 * macOS Sandbox Runtime helpers kept from this fork.
 *
 * v2 sessions still launch through the container driver. These helpers are the
 * fork's host-side sandbox: a sandbox-exec preflight, an allowlisted
 * OPENAI_API_KEY env filter, and a Sandbox Runtime wrapper around a command.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

const ALLOWED_ENV_VARS = ['OPENAI_API_KEY'] as const;
const REQUIRED_TOOLS = ['curl', 'git', 'python3', 'node', 'sed', 'grep'] as const;

export interface SandboxMount {
  hostPath: string;
  readonly: boolean;
}

type Exec = (command: string) => void;

function defaultExec(command: string): void {
  execSync(command, { stdio: 'pipe' });
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Writable mount paths become the sandbox allowWrite list. Read-only mounts stay out. */
export function buildSandboxConfig(mounts: readonly SandboxMount[]): {
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
} {
  return {
    filesystem: {
      denyRead: [],
      allowWrite: mounts.filter((mount) => !mount.readonly).map((mount) => mount.hostPath),
      denyWrite: [],
    },
  };
}

/**
 * Pass only OPENAI_API_KEY through to a sandboxed agent process.
 * Process env wins over `.env`. Every other key in `.env` is dropped.
 */
export function loadFilteredEnv(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of ALLOWED_ENV_VARS) {
    const value = env[key];
    if (value) result[key] = value;
  }

  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) return result;

  const envContent = fs.readFileSync(envFile, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!ALLOWED_ENV_VARS.includes(key as (typeof ALLOWED_ENV_VARS)[number])) continue;
    if (!(key in result)) result[key] = match[2];
  }

  return result;
}

export async function wrapAgentCommand(command: string, mounts: readonly SandboxMount[]): Promise<string> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  return SandboxManager.wrapWithSandbox(command, undefined, buildSandboxConfig(mounts));
}

function warnIfRequiredToolsMissing(exec: Exec): void {
  for (const tool of REQUIRED_TOOLS) {
    try {
      exec(`command -v ${tool}`);
    } catch (err) {
      // `command -v` exits non-zero when the tool is absent. That is the check.
      if (!(err instanceof Error)) throw err;
      log.warn('Required tool not found on PATH', { tool, err });
    }
  }
}

/**
 * Fatal sandbox-exec check from the fork's startup path.
 *
 * Runs on macOS unless NANOCLAW_DISABLE_SANDBOX=1. Other platforms skip the
 * fatal check: sandbox-exec is macOS-only, and v2's session driver is Docker.
 */
export function ensureSandboxRuntime(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exec?: Exec } = {},
): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;

  warnIfRequiredToolsMissing(exec);

  if (env.NANOCLAW_DISABLE_SANDBOX === '1') {
    log.info('Sandbox preflight skipped (NANOCLAW_DISABLE_SANDBOX=1)');
    return;
  }

  if (platform !== 'darwin') {
    log.info('Sandbox preflight skipped; sandbox-exec is macOS-only', { platform });
    return;
  }

  try {
    exec('command -v sandbox-exec');
  } catch (err) {
    log.error('sandbox-exec is not available', { err });
    console.error('\n╔════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: sandbox-exec is not available on this system   ║');
    console.error('║                                                        ║');
    console.error('║  NanoClaw uses Sandbox Runtime on macOS (sandbox-exec) ║');
    console.error('╚════════════════════════════════════════════════════════╝\n');
    throw new Error('sandbox-exec is required but not available', { cause: err });
  }

  try {
    exec(`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`);
  } catch (err) {
    log.error('sandbox-exec failed to apply sandbox', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: sandbox-exec failed to apply a sandbox                 ║');
    console.error('║                                                                ║');
    console.error('║  Try running this in Terminal to verify:                       ║');
    console.error('║    sandbox-exec -p "(version 1)(allow default)" /usr/bin/true  ║');
    console.error('║                                                                ║');
    console.error('║  If it fails, sandbox-exec is blocked on this system.          ║');
    console.error('║  Options:                                                      ║');
    console.error('║    - Set NANOCLAW_DISABLE_SANDBOX=1 to run without sandbox     ║');
    console.error('║    - Or switch back to Docker                                 ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('sandbox-exec failed to apply sandbox', { cause: err });
  }
}
