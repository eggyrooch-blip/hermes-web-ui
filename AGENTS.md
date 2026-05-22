<!-- ftask:managed v1 — auto-generated; edit OUTSIDE this block -->
# Agent rules — hermes-web-ui (managed by ftask)

- This repo is part of sunke's agent-OS. Agents NEVER run git directly here — use `bun ~/.claude/PAI/TOOLS/ftask.ts`.
- Base branch: `main`. Feature work happens in a `ftask new <slug>` worktree, never on `main` directly.
- Test gate: `ftask ship` runs `bun run test` (auto-detected) in the rebased worktree and BLOCKS the merge if it fails.
- When you fix a bug found while troubleshooting (a 排障), add a regression test that FAILS without the fix BEFORE `ftask ship`, and record the root cause as one line under "Known gotchas" below.
- Global protocol: `~/.claude/CLAUDE.md` (Claude) and `~/.codex/AGENTS.md` (Codex) — "AGENT-OS" section. User cheatsheet: `~/code/AGENT-OS.md`.

## Known gotchas
- WebUI MarkdownRenderer used plain markdown-it without a math renderer, so `$...$` / `$$...$$` LaTeX in research answers displayed raw until KaTeX support was added.
<!-- /ftask:managed -->
