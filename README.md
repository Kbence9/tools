# tools

Small command-line tools I use when working with AI coding agents.

| Tool | What it does |
| --- | --- |
| [`wtrun`](worktree-runner/) | Gives every agent task its own disposable `git worktree`, so the main checkout is never touched and unfinished work is never thrown away. |

## wtrun

When an agent works directly in your main checkout, a half-finished or abandoned
task leaves the tree in an unknown state. `wtrun` is a thin, stateless wrapper
around `git worktree`:

- `start` creates a linked worktree for the task **next to** the main checkout
  (`<repo-parent>/.worktrees/<task-name>`), never inside it.
- `finish` removes the worktree only if it is clean. If there are uncommitted
  changes, it leaves everything in place and tells you to review it.
- No config files, no state, no dependencies. Just Node.js and git.

### Install

Requires Node.js 18+ and git.

```bash
git clone https://github.com/Kbence9/tools.git
cd tools/worktree-runner
npm link            # puts `wtrun` on your PATH
```

Or run it without installing:

```bash
node /path/to/tools/worktree-runner/wtrun.js --help
```

### Usage

```
wtrun start <task-name> [--branch <name>]   create a linked worktree for a task
wtrun finish <task-name>                    remove it if clean, else flag for review
wtrun list                                  list worktrees (wtrun-managed marked with *)
wtrun prune                                 git worktree prune + report stale entries
wtrun --help | --version
```

Run `start`, `finish` and `prune` from the **main checkout**. `start` refuses to
run from inside another linked worktree, so task worktrees are never nested.

### Examples

A quick task on a detached `HEAD`:

```bash
cd ~/code/my-app
wtrun start fix-login-bug
cd ../.worktrees/fix-login-bug
#   ... the agent works and commits here ...
cd ~/code/my-app
wtrun finish fix-login-bug     # clean: removed / dirty: kept, exit code 2
```

A task on its own branch, ready for a pull request:

```bash
wtrun start login-fix --branch fix/login   # creates fix/login from HEAD if needed
cd ../.worktrees/login-fix
#   ... commit, then push the branch ...
git push -u origin fix/login
cd -
wtrun finish login-fix                     # the worktree goes, the branch stays
```

If a finished worktree was on a detached `HEAD` with commits that no branch
points at, `finish` still removes it but prints the commit SHA, so you can
recover it with `git branch <name> <sha>`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | error |
| `2` | `finish` found uncommitted changes: nothing removed, review needed |
| `3` | run from the wrong directory (inside a linked worktree) |

### Tests

```bash
cd worktree-runner
npm run smoke       # or: bash test/smoke.sh
```

The smoke test builds a throwaway git repository in `$TMPDIR` and walks the full
flow: `start`, the nested-worktree guard, `finish` on a dirty worktree (must not
remove), commit, `finish` on a clean worktree (must remove), `list` and `prune`.

More detail: [worktree-runner/README.md](worktree-runner/README.md).

## License

[MIT](LICENSE) © 2026 Bence Krisztián-Világos
