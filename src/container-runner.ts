/**
 * Sandbox Runner for NanoClaw
 * Spawns agent execution in a local sandbox and handles IPC
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  GROUPS_DIR,
  DATA_DIR
} from './config.js';
import { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error('Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty');
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    // Global memory directory (read-only for non-main)
    // Containers only support directory mounts, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  }

  // Per-group OpenAI session storage (isolated from other groups)
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, 'openai');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/workspace/sessions',
    readonly: false
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Environment variables are passed directly to the sandboxed process.

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildSandboxConfig(mounts: VolumeMount[]): Partial<SandboxRuntimeConfig> {
  const allowWrite = mounts.filter(m => !m.readonly).map(m => m.hostPath);

  return {
    filesystem: {
      denyRead: [],
      allowWrite,
      denyWrite: []
    }
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function loadFilteredEnv(projectRoot: string): Record<string, string> {
  const envFile = path.join(projectRoot, '.env');
  const allowedVars = ['OPENAI_API_KEY'];
  const result: Record<string, string> = {};

  for (const key of allowedVars) {
    if (process.env[key]) {
      result[key] = process.env[key] as string;
    }
  }

  if (!fs.existsSync(envFile)) return result;

  const envContent = fs.readFileSync(envFile, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!allowedVars.includes(key)) continue;
    if (!(key in result)) result[key] = match[2];
  }

  return result;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const sandboxConfig = buildSandboxConfig(mounts);

  logger.debug({
    group: group.name,
    mounts: mounts.map(m => `${m.hostPath}${m.readonly ? ' (ro)' : ' (rw)'}`)
  }, 'Container mount configuration');

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning container agent');

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const projectRoot = process.cwd();
  const agentRunnerPath = path.join(projectRoot, 'container', 'agent-runner', 'dist', 'index.js');
  const agentCommand = `node ${shellEscape(agentRunnerPath)}`;
  let sandboxedCommand: string;
  try {
    sandboxedCommand = await SandboxManager.wrapWithSandbox(agentCommand, undefined, sandboxConfig);
  } catch (err) {
    logger.error({ group: group.name, error: err }, 'Failed to build sandbox command');
    return {
      status: 'error',
      result: null,
      error: `Sandbox setup failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  return new Promise((resolve) => {
    const globalDir = path.join(GROUPS_DIR, 'global');
    const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, 'openai');
    const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
    const filteredEnv = loadFilteredEnv(projectRoot);

    const env = {
      ...process.env,
      ...filteredEnv,
      NANOCLAW_GROUP_DIR: groupDir,
      NANOCLAW_SESSIONS_DIR: groupSessionsDir,
      NANOCLAW_IPC_DIR: groupIpcDir,
      NANOCLAW_GLOBAL_DIR: fs.existsSync(globalDir) ? globalDir : '',
      NANOCLAW_PROJECT_DIR: input.isMain ? projectRoot : ''
    };

    const container = spawn(sandboxedCommand, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: groupDir,
      env
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
      } else {
        stderr += chunk;
      }
    });

    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`
      });
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code ?? 'null'}`,
        `Signal: ${signal ?? 'none'}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``
      ];

      if (isVerbose) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Sandbox Command ===`,
          sandboxedCommand,
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.hostPath}${m.readonly ? ' (ro)' : ' (rw)'}`).join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.hostPath}${m.readonly ? ' (ro)' : ' (rw)'}`).join('\n'),
          ``
        );

        if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500),
            ``
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error({
          group: group.name,
          code,
          signal,
          duration,
          stderr: stderr.slice(-500),
          logFile
        }, 'Container exited with error');

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}: ${stderr.slice(-200)}`
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info({
          group: group.name,
          duration,
          status: output.status,
          hasResult: !!output.result
        }, 'Container completed');

        resolve(output);
      } catch (err) {
        logger.error({
          group: group.name,
          stdout: stdout.slice(-500),
          error: err
        }, 'Failed to parse container output');

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
