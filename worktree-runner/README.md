# wtrun

`git worktree`-based isolation for agent tasks. A thin, **stateless** wrapper —
no config, no state files, no MCP. Each task gets its own linked worktree in a
scratch directory next to (never inside) the main checkout, and gets cleaned up
again when the task is finished and clean.

## Why

When an agent works in your main checkout, a half-finished or abandoned task
leaves the tree in an unknown state. `wtrun` gives every task a disposable,
isolated worktree so the main checkout is never touched, and `finish` refuses to
throw away work that hasn't been committed.

## Install

Node 18+ (22 is fine). No dependencies.

```bash
npm link          # exposes `wtrun` on PATH
# or just call it directly:
node /path/to/worktree-runner/wtrun.js <command>
```

## Commands

### `wtrun start <task-name> [--branch <name>]`

Creates a linked worktree at `<repo-parent>/.worktrees/<task-name>` and prints
its path.

- **Default:** detached `HEAD` at the current commit (`git worktree add --detach`).
- **`--branch <name>`:** checks out that branch in the worktree, creating it from
  `HEAD` if it doesn't exist yet.
- **Guard:** must be run from the **main checkout**. If run from inside another
  linked worktree it errors (exit `3`) instead of nesting task worktrees — the
  point of the tool is that task work never happens in the wrong tree.

`cd` into the printed path and run the agent session there.

### `wtrun finish <task-name>`

- **Clean** (`git status --porcelain` empty): `git worktree remove`. Exit `0`.
- **Dirty:** does **not** remove anything. Prints the uncommitted changes and the
  worktree path with a "review needed" message. Exit `2`.
- If the worktree was on a detached `HEAD` and now carries commits that no branch
  points at, it still removes it but prints the SHA so you can `git branch` it
  back within git's grace period.
- Run it from the main checkout, not from inside the worktree being finished.

### `wtrun list`

Human-readable view of `git worktree list --porcelain`. wtrun-managed worktrees
(those under `.worktrees/`) are marked with `*`.

### `wtrun prune`

Runs `git worktree prune` and reports which stale entries were cleared.

## Exit codes

| code | meaning |
|------|---------|
| `0`  | success |
| `1`  | error |
| `2`  | `finish` found a dirty worktree — review needed, nothing removed |
| `3`  | run from the wrong directory (guard) |

## Typical flow

```bash
# from the main checkout
wtrun start fix-login-bug
cd ../.worktrees/fix-login-bug
#   ... agent session does its work, commits ...
cd -
wtrun finish fix-login-bug      # clean -> removed;  dirty -> kept for review
```

## Non-goals

No MCP integration. No memory/state. Just a CLI around `git worktree`.

## Smoke test

```bash
npm run smoke      # or: bash test/smoke.sh
```

Creates a throwaway git repo under `$TMPDIR` (`/tmp`), then runs
`start` → modify a file → `finish` (asserts it does **not** remove while dirty) →
commit → `finish` (asserts it **does** remove once clean), plus the linked-worktree
guard, `list`, and `prune`.
