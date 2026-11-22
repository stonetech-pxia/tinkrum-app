# Deploying the model relay service (Mac mini, D-131)

The model relay service (`apps/api`, D-193) runs on the founder's Mac mini and is exposed through a Cloudflare tunnel at `https://morph-api.stonetech.dev`. It does not know the app's version, so upgrading the app needs no redeploy. What it stores is only the requests users actively send (see "Collecting requests" below) and the requests during the test period (see "Saving requests during the test period" below); when changing machines, copy those two files along.

```
App ──https──► Cloudflare ──tunnel morph-prod──► Mac mini 127.0.0.1:8788 (launchd: dev.stonetech.morph-api) ──► Claude
```

| Item            | Location                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Production code | `~/projects/morph-prod` (a separate clone of the local repository, not run from a dev worktree) |
| Keys and limits | `~/projects/morph-prod/.env` (`ANTHROPIC_API_KEY`, `MORPH_CLIENT_TOKEN`, etc.)                  |
| Service         | `~/Library/LaunchAgents/dev.stonetech.morph-api.plist`                                          |
| Tunnel          | `~/.cloudflared/morph-prod.yml`, `~/Library/LaunchAgents/dev.stonetech.morph-tunnel.plist`      |
| Logs            | `~/Library/Logs/morph-api.log`, `~/Library/Logs/morph-tunnel.log`                               |

This tunnel is separate from simo's: restarting or changing Morph does not affect simo.

## Local push gate

After creating a clone or worktree, run `npm run hooks:install` there. It enables `.githooks/pre-push` for that checkout using Git's worktree-specific configuration; it does not change the hook path of other worktrees. Git 2.20 or later is required. The hook runs the full `npm run check` and blocks on failure. Push from a clean checkout of the commit being sent, including when pushing a tag; a different branch's working tree is not evidence that the pushed commit passes. Deletion-only pushes do not publish code and skip the check.

The hook is local to an installed checkout. A new clone must enable it explicitly; it is a development gate, not a server-side security boundary. GitHub Actions is not enabled by this change.

## Releasing a new relay version

Deployment and pushing require the founder's explicit request. Use the script from the reviewed development checkout; `--repo` is the separate production clone. Fetch first, then pin the commit you intend to release. The script does not fetch or push automatically.

```bash
git -C ~/projects/morph-prod fetch origin
# First inspect the resolved commit and plan. No --apply means no writes or restarts.
./scripts/deploy.sh --repo ~/projects/morph-prod --ref origin/main --tag api-YYYY-MM-DD-HHMMSSZ
# Run only for an explicitly authorised release, using the same pinned commit shown above.
./scripts/deploy.sh --repo ~/projects/morph-prod --ref <full-commit-id> --tag api-YYYY-MM-DD-HHMMSSZ --apply
```

The script verifies that the loaded `dev.stonetech.morph-api` job uses this clone's `apps/api` directory and that the current relay is healthy. It locks the deployment, checks the target out in a temporary worktree, runs `npm ci` and the complete `npm run check` there, and only then creates an annotated release tag. The temporary checkout contains tracked code, not production `.env` or request records. Before changing production, it rechecks that its checkout is unchanged and clean. It then checks out the validated commit in production, installs its dependencies, restarts only the relay job, and waits for `/health` to return `ok: true`. The tunnel is left running.

A failed validation leaves production untouched and creates no tag. A failure after changing production attempts to restore the previous checkout, reinstall its dependencies and restart the relay, then checks health again. The command still exits unsuccessfully. A failed candidate's tag is retained for audit; it must not be treated as a successful release. Tags are never overwritten. Temporary validation worktrees and the deployment's own lock are removed on exit; an existing lock is never removed by another invocation.

Deployment receipts are local Git metadata, not API request data:

```bash
git -C ~/projects/morph-prod rev-parse --git-path morph-deployments.jsonl
# Read that file for succeeded / rolledBack, tag, commit and previous commit.
git -C ~/projects/morph-prod tag --list 'api-*'
```

An `api-baseline-*` tag records an observed existing production commit; it is not a new deployment. Release tags and receipts remain local until the founder explicitly requests a push. If a process is forcibly killed and leaves `morph-deploy.lock`, inspect the owning process and checkout before manually removing the stale lock; do not run another deployment around it.

## Rolling back the relay

Choose a previously successful receipt/tag, or the recorded initial production baseline. Do not choose the newest tag blindly: a failed candidate is retained. Review its commit with `git show --no-patch <previous-tag>`.

```bash
./scripts/deploy.sh --repo ~/projects/morph-prod --ref <previous-successful-tag> --tag api-rollback-YYYY-MM-DD-HHMMSSZ
# Only after the founder explicitly requests rollback:
./scripts/deploy.sh --repo ~/projects/morph-prod --ref <previous-successful-tag> --tag api-rollback-YYYY-MM-DD-HHMMSSZ --apply
```

Rollback goes through the same dependency install, full validation, new audit tag, restart and health check. It never rewrites an old tag. Checkout explicitly refuses to overwrite ignored files. The production `.env` and ignored `apps/api/data/` files are retained: there is no `git clean`, account-data restore or data deletion in this procedure. If automatic recovery reports failure, inspect `launchctl print` and the relay logs below; do not restart unrelated jobs or kill processes by command-name pattern.

## When building the app

Four `EXPO_PUBLIC_*` variables are bundled into the app at build time. The complete Android release build and install command, with all four, is in [AGENTS.md](../AGENTS.md) under "Building a release build"; it is kept only there. `EXPO_PUBLIC_MORPH_CLIENT_TOKEN` is the same as `MORPH_CLIENT_TOKEN` in the server's `.env`.

Downloaded tools (D-177–D-179): `EXPO_PUBLIC_MORPH_TOOLS_URL` is the address of the catalog on R2. Scan flattening model (D-274): `EXPO_PUBLIC_MORPH_PACKS_URL` points at `packs/` in the R2 bucket `morph-tools`; paths carry the pack ID and version, and are only added to, never overwritten; when changing the model, update the version, size and hash in `packages/core/src/packs.ts`. The server does not need to know about downloaded tools (the prompt is written by the app, D-193); for the release steps see [TOOL_DOWNLOAD_DESIGN.md](TOOL_DOWNLOAD_DESIGN.md) §13.

The client token is bundled into the app and is not a secret (D-132). Changing the token makes every old app version return 401, so change it only when it is being abused.

## Collecting requests (D-189)

When the AI cannot do something, the user taps "Tell us you need this", and that one sentence is appended to `~/projects/morph-prod/apps/api/data/needs.jsonl` (one JSON per line: time, the sentence, language, rejection reason, which kind of AI was used, platform, version; no device id or IP). The directory is in `.gitignore`, so releasing a new version does not touch it. To change the location, use `MORPH_NEEDS_FILE` in `.env`. At most 20 per device per day, and 2000 per day in total.

```bash
# The last 20
tail -20 ~/projects/morph-prod/apps/api/data/needs.jsonl
# Count by rejection reason (where ai is mock, it is mostly that the built-in rules did not understand, not necessarily a missing feature)
jq -r '.reason + " " + (.ai // "?")' ~/projects/morph-prod/apps/api/data/needs.jsonl | sort | uniq -c
```

When the privacy policy goes live it must say: it is sent only when the user taps the button, and what is sent is only that one sentence.

## Saving requests during the test period (D-240)

During the TestFlight test, set `MORPH_REQUESTS_FILE=data/requests.jsonl` in the production `.env` (relative to `apps/api`, i.e. `~/projects/morph-prod/apps/api/data/requests.jsonl`). After restarting the service, the startup log shows "Saving requests to …". Each successful forward appends one JSON line: time, the first 8 characters of the device id hash, platform, app version, which round, `system` (the planning prompt), `messages` (the UI config and the user's words), the model reply, the stop reason, tokens. Nothing is saved if it is unset. How long to keep it and how to delete it are not decided yet (P-041); the file contains the user's own words, so do not copy it elsewhere or commit it.

```bash
# The last 5: the end of the first message (the user's words are last) and the start of the model reply
tail -5 ~/projects/morph-prod/apps/api/data/requests.jsonl | jq -r '.at, .messages[0].content[-200:], .reply[:200], ""'
# Replies without "kind" (mostly not change plans)
jq -c 'select(.reply | contains("\"kind\"") | not) | {at, reply: .reply[:200]}' ~/projects/morph-prod/apps/api/data/requests.jsonl
```

## State the Mac must keep

- No sleep (`sleep 0` in `pmset -g`), and power on automatically after a power loss (`autorestart 1`).
- **Automatic login** after boot: a LaunchAgent starts only after the user logs in, so after a system-update restart with no login the service will not come up.
- Set a monthly spend cap in the Anthropic console: the token can be extracted, so this is the last safeguard on cost.

## Troubleshooting

```bash
launchctl print gui/$(id -u)/dev.stonetech.morph-api | grep -E 'state|last exit'
tail -50 ~/Library/Logs/morph-api.log
~/.cloudflared/bin/cloudflared tunnel info morph-prod
```
