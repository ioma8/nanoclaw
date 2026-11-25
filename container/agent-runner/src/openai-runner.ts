/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { z } from 'zod';
import {
  Agent,
  run,
  webSearchTool,
  tool,
  type AgentInputItem,
  type Session,
  user,
  assistant,
  system
} from '@openai/agents';
import { createIpcTools } from './ipc-mcp.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
const DEFAULT_SHELL_MAX_OUTPUT = 8_000;
const DEFAULT_READ_MAX_BYTES = 200_000;
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const PROJECT_DIR = process.env.NANOCLAW_PROJECT_DIR || '/workspace/project';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const SESSIONS_DIR = process.env.NANOCLAW_SESSIONS_DIR || '/workspace/sessions';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function readOptionalFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function buildInstructions(): string {
  const groupInstructions = readOptionalFile(path.join(GROUP_DIR, 'CLAUDE.md'));
  const globalBase = GLOBAL_DIR && GLOBAL_DIR.trim() ? GLOBAL_DIR : '';
  const projectBase = PROJECT_DIR && PROJECT_DIR.trim() ? PROJECT_DIR : '';
  const globalInstructions = (globalBase ? readOptionalFile(path.join(globalBase, 'CLAUDE.md')) : '')
    || (projectBase ? readOptionalFile(path.join(projectBase, 'groups', 'global', 'CLAUDE.md')) : '');

  const parts = [globalInstructions, groupInstructions].filter(Boolean);
  if (parts.length === 0) {
    return 'You are a helpful assistant.';
  }

  return parts.join('\n\n');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveAllowedPath(candidate: string, allowedRoots: string[]): string {
  const resolved = path.resolve(candidate);
  const isAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!isAllowed) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

function resolveToolPath(inputPath: string, allowedRoots: string[], baseDir = GROUP_DIR): string {
  const absolute = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(baseDir, inputPath);
  return resolveAllowedPath(absolute, allowedRoots);
}

class FileSession implements Session {
  private readonly sessionId: string;
  private readonly filePath: string;

  constructor(sessionId?: string) {
    ensureDir(SESSIONS_DIR);
    this.sessionId = sessionId || crypto.randomUUID();
    this.filePath = path.join(SESSIONS_DIR, `${this.sessionId}.json`);
  }

  private readStored(): StoredMessage[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    if (!Array.isArray(raw)) return [];

    const looksStored = raw.every(item => item && typeof item.role === 'string' && typeof item.text === 'string');
    if (looksStored) {
      return raw as StoredMessage[];
    }

    const migrated = extractStoredFromItems(raw as AgentInputItem[]);
    this.writeStored(migrated);
    return migrated;
  }

  private writeStored(items: StoredMessage[]): void {
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2));
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const stored = this.readStored();
    const slice = typeof limit === 'number' ? stored.slice(-limit) : stored;
    return slice.map(item => {
      if (item.role === 'system') return system(item.text);
      if (item.role === 'assistant') return assistant(item.text);
      return user(item.text);
    });
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const existing = this.readStored();
    const next = existing.concat(extractStoredFromItems(items));
    this.writeStored(next);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const stored = this.readStored();
    const item = stored.pop();
    this.writeStored(stored);
    if (!item) return undefined;
    if (item.role === 'system') return system(item.text);
    if (item.role === 'assistant') return assistant(item.text);
    return user(item.text);
  }

  async clearSession(): Promise<void> {
    this.writeStored([]);
  }
}

async function runCommand(command: string, timeoutMs: number, maxOutputLength: number, cwd: string) {
  return new Promise<{ stdout: string; stderr: string; outcome: { type: 'timeout' } | { type: 'exit'; exitCode: number | null } }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: process.env
    });

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      resolve({
        stdout: stdout.slice(0, maxOutputLength),
        stderr: stderr.slice(0, maxOutputLength),
        outcome: { type: 'timeout' }
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutputLength) {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutputLength) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({
        stdout: stdout.slice(0, maxOutputLength),
        stderr: stderr.slice(0, maxOutputLength),
        outcome: { type: 'exit', exitCode: code === null ? null : code }
      });
    });
  });
}

function appendConversationLog(prompt: string, output: string | null): void {
  if (!output) return;
  const conversationsDir = path.join(GROUP_DIR, 'conversations');
  ensureDir(conversationsDir);
  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(conversationsDir, `${date}.md`);
  const timestamp = new Date().toISOString();
  const entry = [
    `## ${timestamp}`,
    '',
    '**User**:',
    prompt.trim(),
    '',
    '**Assistant**:',
    output.trim(),
    '',
    '---',
    ''
  ].join('\n');
  fs.appendFileSync(filePath, entry);
}

function createLocalTools(allowedRoots: string[]) {
  const bashTool = tool({
    name: 'bash',
    description: 'Primary and working bash execution tool. Use it to run commands of all kinds. It is safe because commands run inside the sandbox.',
    parameters: z.object({
      command: z.string().describe('Bash command to run')
    }),
    execute: async (args) => {
      const timeoutMs = DEFAULT_SHELL_TIMEOUT_MS;
      const maxOutputLength = DEFAULT_SHELL_MAX_OUTPUT;
      const baseDir = GROUP_DIR;
      const result = await runCommand(args.command, timeoutMs, maxOutputLength, baseDir);
      const exit = result.outcome.type === 'exit' ? result.outcome.exitCode : 'timeout';
      return `exit=${exit}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`.trim();
    }
  });

  const readFileTool = tool({
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    parameters: z.object({
      path: z.string().describe('Path to the file (relative to /workspace/group) or absolute')
    }),
    execute: async (args) => {
      const filePath = resolveToolPath(args.path, allowedRoots);
      const maxBytes = DEFAULT_READ_MAX_BYTES;
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return `Not a file: ${filePath}`;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.slice(0, maxBytes);
    }
  });

  const writeFileTool = tool({
    name: 'write_file',
    description: 'Write a text file to the workspace.',
    parameters: z.object({
      path: z.string().describe('Path to the file (relative to /workspace/group) or absolute'),
      content: z.string().describe('File contents')
    }),
    execute: async (args) => {
      const filePath = resolveToolPath(args.path, allowedRoots);
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, args.content);
      return `Wrote ${filePath}`;
    }
  });

  const listDirTool = tool({
    name: 'list_files',
    description: 'List files in a directory.',
    parameters: z.object({
      path: z.string().describe('Directory path (relative to /workspace/group) or absolute')
    }),
    execute: async (args) => {
      const dirPath = resolveToolPath(args.path, allowedRoots);
      const entries = fs.readdirSync(dirPath);
      return entries.join('\n');
    }
  });

  return [bashTool, readFileTool, writeFileTool, listDirTool];
}

type StoredMessage = {
  role: 'user' | 'assistant' | 'system';
  text: string;
};

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: string }).text;
        return text ?? '';
      }
      return '';
    }).join('');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: string }).text;
    return text ?? '';
  }
  return '';
}

function extractStoredFromItems(items: AgentInputItem[]): StoredMessage[] {
  const stored: StoredMessage[] = [];
  for (const item of items) {
    const candidate = item as { type?: string; role?: string; content?: unknown };
    if (candidate.type !== 'message' || !candidate.role) continue;
    const text = extractTextFromContent(candidate.content).trim();
    if (!text) continue;
    if (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system') {
      stored.push({ role: candidate.role, text });
    }
  }
  return stored;
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const ipcTools = createIpcTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  const allowedRoots = input.isMain ? [GROUP_DIR, PROJECT_DIR] : [GROUP_DIR];
  const tools = [
    webSearchTool({ searchContextSize: 'medium' }),
    ...createLocalTools(allowedRoots),
    ...ipcTools
  ];

  const agent = new Agent({
    name: 'Andy',
    instructions: buildInstructions(),
    tools,
    model: 'gpt-5-mini-2025-08-07',
    modelSettings: {
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' }
    }
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  try {
    log('Starting agent...');

    const session = new FileSession(input.sessionId);
    const runResult = await run(agent, prompt, { session });
    newSessionId = await session.getSessionId();

    if (runResult.finalOutput !== undefined && runResult.finalOutput !== null) {
      result = typeof runResult.finalOutput === 'string'
        ? runResult.finalOutput
        : JSON.stringify(runResult.finalOutput);
    }

    appendConversationLog(input.prompt, result);

    log('Agent completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
