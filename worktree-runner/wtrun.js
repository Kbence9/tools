#!/usr/bin/env node
'use strict';

/*
 * wtrun — git worktree isolation for agent tasks.
 *
 * A thin, stateless wrapper around `git worktree`. No config, no state files,
 * no MCP. It just puts each task in its own linked worktree in a scratch dir
 * and cleans it up again when the task is done and clean.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = '0.1.0';

const EXIT_ERROR = 1;   // generic failure
const EXIT_DIRTY = 2;   // finish: worktree dirty, review required
const EXIT_GUARD = 3;   // run from the wrong directory

const HELP = `wtrun ${VERSION} — git worktree isolation for agent tasks

usage:
  wtrun start <task-name> [--branch <name>]   create a linked worktree for a task
  wtrun finish <task-name>                    remove it if clean, else flag for review
  wtrun list                                  list worktrees (wtrun-managed marked with *)
  wtrun prune                                 git worktree prune + report stale entries
  wtrun --help | --version

Worktrees are created at:  <repo-parent>/.worktrees/<task-name>
(i.e. a sibling of the main checkout, never inside it).

start detaches from the current HEAD by default. With --branch <name> it checks
out that branch, creating it from HEAD if it does not exist yet.

exit codes:  0 ok   1 error   2 finish/dirty (review needed)   3 wrong directory
`;

function out(msg = '') { process.stdout.write(msg + '\n'); }

function die(msg, code = EXIT_ERROR) {
  for (const line of String(msg).split('\n')) process.stderr.write(`wtrun: ${line}\n`);
  process.exit(code);
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function gitTry(args, opts = {}) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').trim() }; }
}

function real(p) {
  try { return fs.realpathSync(p); }
  catch { return path.resolve(p); }
}

function repoContext() {
  if (!gitTry(['rev-parse', '--git-dir']).ok) {
    die('not inside a git repository');
  }
  if (git(['rev-parse', '--is-bare-repository']) === 'true') {
    die('the repository is bare; wtrun needs a normal checkout');
  }

  const gitDir = real(git(['rev-parse', '--absolute-git-dir']));

  let commonDir;
  const abs = gitTry(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (abs.ok) {
    commonDir = abs.out;
  } else {
    commonDir = git(['rev-parse', '--git-common-dir']);
    if (!path.isAbsolute(commonDir)) commonDir = path.resolve(commonDir);
  }
  commonDir = real(commonDir);

  const inLinkedWorktree = gitDir !== commonDir;
  const mainWorktree = path.dirname(commonDir);            // .../<repo>/.git -> .../<repo>
  const worktreesRoot = path.join(path.dirname(mainWorktree), '.worktrees');

  return { gitDir, commonDir, inLinkedWorktree, mainWorktree, worktreesRoot };
}

function listWorktrees() {
  const porcelain = git(['worktree', 'list', '--porcelain']);
  const entries = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
      entries.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = line.slice('prunable '.length) || true;
    }
  }
  return entries;
}

function findEntry(entries, destPath) {
  const target = real(destPath);
  return entries.find((w) => real(w.path) === target);
}

function isInside(child, parent) {
  const c = real(child);
  const p = real(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

// ---------------------------------------------------------------------------

function cmdStart(argv) {
  let branch = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch' || a === '-b') {
      branch = argv[++i];
      if (!branch) die('--branch requires a value');
    } else if (a.startsWith('--branch=')) {
      branch = a.slice('--branch='.length);
    } else if (a.startsWith('-')) {
      die(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  const task = positional[0];
  if (!task) die('usage: wtrun start <task-name> [--branch <name>]');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task) || task.includes('..')) {
    die(`invalid task name: ${task}`);
  }

  const ctx = repoContext();

  // Guard: tasks are created from the main checkout, never from inside another
  // linked worktree. Doing task work in the wrong tree is the whole thing this
  // tool exists to prevent, so refuse loudly instead of nesting worktrees.
  if (ctx.inLinkedWorktree) {
    die(
      'you are inside a linked worktree, not the main checkout.\n' +
      'run `wtrun start` from the main checkout:\n' +
      `  ${ctx.mainWorktree}`,
      EXIT_GUARD,
    );
  }

  const dest = path.join(ctx.worktreesRoot, task);

  if (findEntry(listWorktrees(), dest)) {
    die(`a worktree for "${task}" already exists:\n  ${dest}`);
  }
  if (fs.existsSync(dest)) {
    die(`destination already exists on disk:\n  ${dest}`);
  }

  fs.mkdirSync(ctx.worktreesRoot, { recursive: true });

  let addArgs;
  let refLabel;
  if (branch) {
    const exists = gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    addArgs = exists
      ? ['worktree', 'add', dest, branch]
      : ['worktree', 'add', '-b', branch, dest];
    refLabel = exists ? `branch ${branch}` : `new branch ${branch} (from HEAD)`;
  } else {
    addArgs = ['worktree', 'add', '--detach', dest];
    refLabel = 'detached HEAD';
  }

  const res = gitTry(addArgs);
  if (!res.ok) die(`git worktree add failed:\n${res.err}`);

  const head = git(['rev-parse', '--short', 'HEAD'], { cwd: dest });

  out();
  out(`  task      ${task}`);
  out(`  ref       ${refLabel} @ ${head}`);
  out(`  worktree  ${dest}`);
  out();
  out('  cd into the worktree and run the agent session there:');
  out(`    cd "${dest}"`);
  out();
  out(`  when finished:  wtrun finish ${task}`);
  out();
}

function cmdFinish(argv) {
  const task = argv[0];
  if (!task) die('usage: wtrun finish <task-name>');

  const ctx = repoContext();
  const dest = path.join(ctx.worktreesRoot, task);
  const entry = findEntry(listWorktrees(), dest);

  if (!entry) {
    die(`no worktree registered for "${task}" at:\n  ${dest}\nrun \`wtrun list\` to see what exists`);
  }
  if (!fs.existsSync(dest)) {
    die(`worktree directory is missing:\n  ${dest}\nrun \`wtrun prune\` to drop the stale entry`);
  }
  if (isInside(process.cwd(), dest)) {
    die(
      `you are inside the worktree you are trying to finish.\n` +
      `run \`wtrun finish\` from the main checkout:\n  ${ctx.mainWorktree}`,
      EXIT_GUARD,
    );
  }

  const status = git(['status', '--porcelain'], { cwd: dest });
  if (status) {
    out();
    out(`  ${task}: worktree is DIRTY — leaving it in place.`);
    out();
    out('  uncommitted changes:');
    for (const line of status.split('\n')) out(`    ${line}`);
    out();
    out('  review needed at:');
    out(`    ${dest}`);
    out();
    process.exit(EXIT_DIRTY);
  }

  // Clean tree. Warn if a detached HEAD carries commits that no ref points at —
  // removing the worktree makes them unreachable.
  let orphan = null;
  if (entry.detached) {
    const contains = gitTry(['for-each-ref', '--contains', 'HEAD'], { cwd: dest });
    if (contains.ok && contains.out === '') {
      orphan = git(['rev-parse', 'HEAD'], { cwd: dest });
    }
  }

  const res = gitTry(['worktree', 'remove', dest]);
  if (!res.ok) {
    die(`git worktree remove failed:\n${res.err}\nworktree left in place: ${dest}`);
  }

  out();
  out(`  ${task}: clean — worktree removed.`);
  out(`  ${dest}`);
  if (orphan) {
    out();
    out(`  warning: this worktree had a detached HEAD at ${orphan.slice(0, 12)} with`);
    out('           commits not reachable from any branch. To recover them soon:');
    out(`             git branch <name> ${orphan.slice(0, 12)}`);
  }
  out();
}

function cmdList() {
  const ctx = repoContext();
  const entries = listWorktrees();
  const root = real(ctx.worktreesRoot);

  if (entries.length === 0) {
    out('no worktrees');
    return;
  }

  for (const w of entries) {
    const managed = isInside(w.path, root) && real(w.path) !== root;
    let ref;
    if (w.bare) ref = 'bare';
    else if (w.branch) ref = w.branch;
    else if (w.detached) ref = `detached ${(w.head || '').slice(0, 7)}`;
    else ref = (w.head || '').slice(0, 7);

    const tags = [];
    if (managed) tags.push('wtrun');
    if (w.locked) tags.push('locked');
    if (w.prunable) tags.push('prunable');

    out(`${managed ? '*' : ' '} ${w.path}`);
    out(`    ${ref}${tags.length ? '   [' + tags.join(', ') + ']' : ''}`);
  }
}

function cmdPrune() {
  const ctx = repoContext();

  const before = listWorktrees();
  const stale = before.filter(
    (w) => !w.bare && (w.prunable || !fs.existsSync(w.path)),
  );

  const res = gitTry(['worktree', 'prune', '--verbose']);
  if (!res.ok) die(`git worktree prune failed:\n${res.err}`);

  out();
  if (res.out) {
    for (const line of res.out.split('\n')) out(`  ${line}`);
  } else {
    out('  nothing to prune');
  }
  out();

  if (stale.length) {
    out('  stale entries cleared:');
    for (const w of stale) out(`    ${w.path}`);
    out();
  }

  void ctx;
}

// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'start':  return cmdStart(argv);
    case 'finish': return cmdFinish(argv);
    case 'list':   return cmdList(argv);
    case 'prune':  return cmdPrune(argv);
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return;
    case '-v':
    case '--version':
      process.stdout.write(VERSION + '\n');
      return;
    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main();
