# Fork runtime

This branch is [ioma8/nanoclaw](https://github.com/ioma8/nanoclaw). Three commits on top of NanoClaw v1 switched the assistant to the OpenAI Agents SDK and the macOS Sandbox Runtime, and ignored per-group conversation logs. Upstream `main` after that point is NanoClaw v2 (container sessions, provider drivers, pnpm/Bun). Those histories touch the same files and do not splice: dropping the fork's v1 function bodies into the v2 files leaves neither runtime able to run.

What this merge keeps from the fork, and where it lives now:

## OpenAI Agents SDK

`container/agent-runner/src/openai-runner.ts` is the fork's one-shot runner (stdin JSON in, sentinel JSON out). It still builds an `@openai/agents` agent named Andy on `gpt-5-mini-2025-08-07`, with `web_search`, local `read_file` / `write_file` / `bash`, and the IPC tools in `container/agent-runner/src/ipc-mcp.ts` (`send_message` and scheduled tasks). Session transcripts stay under the `openai/` directory the runner already used.

Run it with Bun from `container/agent-runner`:

```bash
bun src/openai-runner.ts
```

v2's container entry remains `bun src/index.ts` (the poll loop and Claude provider). The OpenAI runner is not the default session provider. Wiring it through v2's provider contract is follow-up work; replacing `src/index.ts` with the v1 file would drop the v2 host.

## Sandbox Runtime

`src/sandbox-runtime.ts` keeps the fork's host-side sandbox behavior:

- On macOS, startup runs `sandbox-exec` and refuses to boot if it is missing or cannot apply a profile. `NANOCLAW_DISABLE_SANDBOX=1` skips that fatal check (the message the fork printed, now honored).
- Other platforms skip the fatal check. `sandbox-exec` is macOS-only, and v2's session driver is Docker.
- `loadFilteredEnv` still forwards only `OPENAI_API_KEY` into a sandboxed process.
- `buildSandboxConfig` still turns writable mounts into the Sandbox Runtime `allowWrite` list. `wrapAgentCommand` wraps a command with `@anthropic-ai/sandbox-runtime`.

v2 session containers are still started by `src/drivers/docker-driver.ts`. The fork's old `runContainerAgent` spawn (Apple Container, then a sandboxed `node` of the agent runner) targeted types v2 removed (`RegisteredGroup`, stdin IPC). It is not the v2 session path.

## Conversation logs

`.gitignore` keeps the fork's `groups/*/conversations/` rule, in addition to upstream's `groups/*`.

## Group memory

Upstream untracked the v1 group seed files. This fork had edited them (tool names `web_search`, `read_file`, `write_file`, `bash`, and `send_message`) and `groups/main/CLAUDE.md` carries this install's memory, including Qwibit Ops. Those three files stay tracked:

- `groups/global/CLAUDE.md`
- `groups/main/CLAUDE.md`
- `groups/nanoclaw-testing/CLAUDE.md`

## Repository guidelines file

The fork added `AGENTS.md` as contributor guidelines. Upstream v2 made `AGENTS.md` a symlink to `CLAUDE.md` so agent harnesses read one project document. The symlink stays. The guidelines the fork added are below. v2's current commands are `pnpm` (host) and `bun` (agent-runner); `pnpm test` is the host suite. The list here is the text from the fork's `AGENTS.md`, unchanged.

# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript source (entrypoint `src/index.ts`, container orchestration in `src/container-runner.ts`, scheduling in `src/task-scheduler.ts`, DB in `src/db.ts`).
- `groups/` holds per-group state, including each group’s `CLAUDE.md` memory.
- `assets/` contains static images (e.g., logo).
- `docs/` contains reference docs, including `docs/SECURITY.md`.
- `config-examples/` provides sample configs and templates.
- `container/` holds container-related tooling and helpers.

## Build, Test, and Development Commands
- `npm run dev` — run the app in development via `tsx`.
- `npm run build` — compile TypeScript to `dist/`.
- `npm run start` — run the compiled app (`dist/index.js`).
- `npm run auth` — run the WhatsApp auth helper.
- `npm run typecheck` — TypeScript type check without emitting files.

## Coding Style & Naming Conventions
- TypeScript, ES modules (`"type": "module"` in `package.json`).
- Follow existing 2‑space indentation and current import style.
- Prefer descriptive, imperative function names (e.g., `registerGroup`, `syncGroupMetadata`).
- Keep changes small and aligned with the project’s “small enough to understand” philosophy.

## Testing Guidelines
- No automated test suite is currently defined.
- Run `npm run typecheck` before submitting changes.
- For skill changes, test the skill on a fresh clone (see `CONTRIBUTING.md`).

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and sentence case (e.g., “Add Docker support”, “Fix message cursor”).
- PR scope is intentionally narrow: bug fixes, security fixes, and simplifications only.
- New capabilities should be contributed as skills in `.claude/skills/` and must not modify source files.
- PRs should describe the change clearly and note how it was validated (e.g., `npm run typecheck`).

## Security & Configuration Tips
- Review `docs/SECURITY.md` before changing isolation or mounts.
- Keep container boundaries intact; prefer skills for optional integrations.
