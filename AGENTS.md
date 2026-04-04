# ThreadEx Agent Guide

This file is the working contract for agents in this repository. Read it before making changes.

## Project Snapshot

ThreadEx is a Codex-first macOS desktop app built with:

- `Tauri v2`
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
  - strongest Tauri/Codex desktop reference
  - use for app-server event handling, approvals, review flows, and desktop orchestration
- `pingdotgg/t3code`:
  - strongest reference for Codex-first event brokering and session lifecycle handling
- `coollabsio/jean`:
  - strongest reference for project/worktree/session modeling

### Local docs

- `.codex/skills/threadex-standards/SKILL.md`

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

- `src-tauri/src/commands/*`

Put behavior in domain/runtime/service modules instead of command handlers.

### Key backend anchors

- `src-tauri/src/lib.rs`
- `src-tauri/src/runtime/protocol.rs`
- `src-tauri/src/runtime/session.rs`
- `src-tauri/src/runtime/supervisor.rs`
- `src-tauri/src/domain/conversation.rs`
- `src-tauri/src/services/workspace.rs`

### Tauri rules

- Use explicit, typed commands
- Validate inputs up front and fail fast
- Do not expose unrestricted shell/process behavior to the frontend
- Keep capabilities/permissions least-privilege
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
cargo test --manifest-path src-tauri/Cargo.toml
```

Also run this when desktop/runtime/Tauri behavior changed:

```bash
bun run tauri:build:debug
```

If you changed Rust runtime or protocol code, also run:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
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

## Change Strategy

When implementing a new Codex-facing feature:

1. Inspect the current local implementation
2. Inspect the official behavior / reference repos
3. Extend the canonical ThreadEx path
4. Add regression coverage
5. Run the completion gates

If a reviewer comment conflicts with the current canonical architecture, verify the code and protocol before changing anything just to satisfy the comment.
