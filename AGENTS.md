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
