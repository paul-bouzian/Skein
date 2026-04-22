# Skein Agent Guide

This file is the working contract for agents in this repository. Read it before making changes.

## Project Snapshot

Skein is a Codex-first macOS desktop app built with:

- `Electron 41`
- `React 19`
- `TypeScript`
- `Rust`
- `codex app-server`

The app is local-first and Codex-only. It is not a generic multi-provider chat shell.

## Product Model

Treat these as canonical:

- `Project -> Environment -> Thread`
- A worktree is an `Environment`, not a `Thread`
- Multiple threads can exist inside the same environment
- One long-lived Codex runtime is environment-scoped

UI note:

- The project card represents the local environment
- Only worktrees appear as child environments under a project

## First Principles

1. Use Codex natively through `codex app-server`
2. Do not reconstruct state from terminal scraping when structured events already exist
3. Keep Rust as the authority for privileged logic, runtime supervision, persistence, Git, and worktrees
4. Keep React focused on rendering, UI state, and typed interaction with the backend
5. Keep one canonical implementation path; do not add duplicate local shortcuts

## Before You Implement a Feature

If the feature already exists in mature Codex apps, inspect references first. Do not invent behavior or wire formats blindly.

Use this order:

1. Official OpenAI/Codex behavior and docs
2. `openai/codex`
3. `Dimillian/CodexMonitor`
4. `pingdotgg/t3code`
5. `coollabsio/jean`

Use the references for:

- `codex app-server` protocol behavior
- plans, approvals, and `requestUserInput`
- subagents
- worktree/session modeling
- review/diff flows
- session restore and runtime edge cases

Do not clone another app visually. Reuse behavior and product framing, not brand or layout.

## Reference Map

### Official / primary references

- OpenAI Codex docs and `openai/codex`:
  - source of truth for protocol behavior and product semantics
- `Dimillian/CodexMonitor`:
  - strongest desktop Codex reference for event handling, approvals, review flows, and orchestration
  - use for app-server event handling, approvals, review flows, and desktop orchestration
- `pingdotgg/t3code`:
  - strongest reference for Codex-first event brokering and session lifecycle handling
- `coollabsio/jean`:
  - strongest reference for project/worktree/session modeling

### Local docs

- `.codex/skills/skein-standards/SKILL.md`

Local-only engineering or project notes may exist in `docs/`, but they are not part of the public repository contract and should not be assumed to be tracked.

If protocol details are unclear, generate the local schema:

```bash
codex app-server generate-json-schema --out ./codex-schema
```

Inspect the generated schema before changing payload shapes.

## Current Product Surfaces

Already implemented and should be treated as real product behavior:

- project/environment/thread workspace shell
- real Codex conversation runtime
- model / reasoning / mode / access composer controls
- plan mode with approve/refine
- `requestUserInput`
- approvals for command/file/permissions
- subagent strip
- context window meter
- project card maps to local environment

When extending these features, preserve the current product model instead of layering alternate flows beside them.

## Backend Architecture Rules

### Rust owns

- Codex runtime protocol and session handling
- process supervision
- filesystem and Git operations
- worktree lifecycle
- persistence and schema evolution
- validation at command boundaries

### Keep these modules thin

- `desktop-backend/src/commands/*`

Put behavior in domain/runtime/service modules instead of command handlers.

### Key backend anchors

- `desktop-backend/src/lib.rs`
- `desktop-backend/src/runtime/protocol.rs`
- `desktop-backend/src/runtime/session.rs`
- `desktop-backend/src/runtime/supervisor.rs`
- `desktop-backend/src/domain/conversation.rs`
- `desktop-backend/src/services/workspace.rs`

### Desktop shell rules

- Electron main/preload own windowing, menu, updater, dialogs, external open, notifications, and preview protocol
- The Rust sidecar owns privileged product logic and is reached through typed JSONL RPC
- Keep preload exposure explicit; never expose raw `ipcRenderer`
- Validate inputs up front and fail fast
- Do not expose unrestricted shell/process behavior to the frontend
- Return structured results, not ad hoc strings

## Frontend Architecture Rules

### React owns

- rendering
- local UI state
- interaction composition
- design-system usage
- typed consumption of backend state

### Do not

- scatter raw `invoke()` calls across components
- duplicate bridge logic in multiple features
- mirror backend state into multiple frontend sources of truth
- use effects for render derivation

### Key frontend anchors

- `src/directions/studio/*`
- `src/stores/conversation-store.ts`
- `src/stores/workspace-store.ts`
- `src/lib/bridge.ts`
- `src/lib/types.ts`

### UI / design-system rules

- Reuse the existing shell and tokens
- Keep the same radii, spacing rhythm, border logic, and interaction states
- Prefer shared components/helpers over repeated one-off markup
- Do not hardcode random colors, spacing, or control styles in new components
- Preserve the current desktop feel and visual coherence

## State and Data Rules

- Keep one source of truth per concern
- Conversation runtime truth lives in Rust and is projected to the frontend
- Workspace truth lives in the workspace service/store path
- Composer defaults follow explicit precedence:
  - global settings
  - project/environment context where applicable
  - thread overrides only when justified

Do not introduce a second hidden state path for the same business rule.

## Reliability Rules

Optimize for:

- restart safety
- reconnect safety
- partial stream handling
- pending interactive request handling
- predictable behavior under runtime failures

If a tradeoff is required, choose correctness and recoverability over convenience.

## Testing and Completion Gates

Run these before considering a task done:

```bash
bun run verify
cargo test --manifest-path desktop-backend/Cargo.toml
```

Also run this when the Electron shell, preload, updater, or packaging behavior changed:

```bash
bun run verify:electron
```

If you changed Rust runtime or protocol code, also run:

```bash
cargo clippy --manifest-path desktop-backend/Cargo.toml --all-targets -- -D warnings
```

Add or update tests for:

- protocol parsing
- runtime/session edge cases
- store behavior
- UI rendering of new runtime states

Do not mark work complete with failing checks.

## Tooling Rules

- Use `bun`, not `npm` or `pnpm`, for this repo
- Use `gh` for GitHub operations
- Match current project conventions before introducing new structure

## Review Guidelines

- Treat security regressions, auth/authz bypasses, tenant-boundary violations, secret exposure, and destructive data-loss risks as P0 issues.
- Treat behavior changes without adequate regression coverage as P1 issues when the change affects runtime behavior, persistence, Git/worktree flows, approvals, or protocol handling.
- Treat missing tests as P1 issues when code changes alter business logic, runtime/session behavior, persistence, or user-visible workflows.
- Treat missing documentation as P1 issues when a change affects public project contracts such as `AGENTS.md`, developer setup, workflow semantics, or operator-facing behavior.
- Treat risky dependency, permissions, sandbox, network, or environment-policy changes as P1 issues unless the change is fully justified and validated.
- Do not raise purely stylistic or cosmetic nits unless they hide a correctness, accessibility, or maintainability risk.

## Change Strategy

When implementing a new Codex-facing feature:

1. Inspect the current local implementation
2. Inspect the official behavior / reference repos
3. Extend the canonical Skein path
4. Add regression coverage
5. Run the completion gates

If a reviewer comment conflicts with the current canonical architecture, verify the code and protocol before changing anything just to satisfy the comment.
