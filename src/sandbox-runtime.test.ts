import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { buildSandboxConfig, ensureSandboxRuntime, loadFilteredEnv, shellEscape } from './sandbox-runtime.js';

describe('buildSandboxConfig', () => {
  it('allowlists only writable host paths', () => {
    expect(
      buildSandboxConfig([
        { hostPath: '/data/sessions/main/openai', readonly: false },
        { hostPath: '/groups/global', readonly: true },
      ]),
    ).toEqual({
      filesystem: {
        denyRead: [],
        allowWrite: ['/data/sessions/main/openai'],
        denyWrite: [],
      },
    });
  });
});

describe('shellEscape', () => {
  it('wraps a path in single quotes and escapes embedded quotes', () => {
    expect(shellEscape("/tmp/agent's runner")).toBe(`'/tmp/agent'\\''s runner'`);
  });
});

describe('loadFilteredEnv', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('keeps OPENAI_API_KEY and drops every other .env entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sandbox-env-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=from-file\nANTHROPIC_API_KEY=secret\n# comment\n');

    expect(loadFilteredEnv(dir, {})).toEqual({ OPENAI_API_KEY: 'from-file' });
  });

  it('lets the process environment win over .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sandbox-env-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=from-file\n');

    expect(loadFilteredEnv(dir, { OPENAI_API_KEY: 'from-env' })).toEqual({ OPENAI_API_KEY: 'from-env' });
  });
});

describe('ensureSandboxRuntime', () => {
  it('skips the fatal check off macOS', () => {
    const exec = vi.fn();
    ensureSandboxRuntime({ platform: 'linux', env: {}, exec });
    expect(exec).toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => String(call[0]).includes('sandbox-exec -p'))).toBe(false);
  });

  it('skips the fatal check when NANOCLAW_DISABLE_SANDBOX=1', () => {
    const exec = vi.fn();
    ensureSandboxRuntime({ platform: 'darwin', env: { NANOCLAW_DISABLE_SANDBOX: '1' }, exec });
    expect(exec.mock.calls.some((call) => String(call[0]).includes('sandbox-exec'))).toBe(false);
  });

  it('throws the fork error when sandbox-exec is missing on macOS', () => {
    const exec = vi.fn((command: string) => {
      if (command.includes('sandbox-exec')) throw new Error('not found');
    });
    expect(() => ensureSandboxRuntime({ platform: 'darwin', env: {}, exec })).toThrow(
      'sandbox-exec is required but not available',
    );
  });

  it('throws when sandbox-exec cannot apply a profile', () => {
    const exec = vi.fn((command: string) => {
      if (command.includes('sandbox-exec -p')) throw new Error('blocked');
    });
    expect(() => ensureSandboxRuntime({ platform: 'darwin', env: {}, exec })).toThrow(
      'sandbox-exec failed to apply sandbox',
    );
  });
});
