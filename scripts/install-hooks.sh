#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
# hooksPath 写进本 worktree，不改变其他会话的钩子。已有特殊 worktree 配置时不擅自搬动。
if git config --local --get core.worktree >/dev/null 2>&1 ||
   [ "$(git config --local --get core.bare || true)" = true ]; then
  echo 'Existing core.worktree/core.bare configuration needs migration before enabling per-worktree hooks.' >&2
  exit 1
fi
git config --local extensions.worktreeConfig true
git config --worktree core.hooksPath "$(pwd)/.githooks"
echo 'Pre-push checks enabled for this worktree.'
