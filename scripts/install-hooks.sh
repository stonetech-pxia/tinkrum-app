#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
# Write hooksPath into the current worktree without modifying hooks for other sessions. Do not move it automatically if a special worktree configuration already exists.
if git config --local --get core.worktree >/dev/null 2>&1 ||
   [ "$(git config --local --get core.bare || true)" = true ]; then
  echo 'Existing core.worktree/core.bare configuration needs migration before enabling per-worktree hooks.' >&2
  exit 1
fi
git config --local extensions.worktreeConfig true
git config --worktree core.hooksPath "$(pwd)/.githooks"
echo 'Pre-push checks enabled for this worktree.'
