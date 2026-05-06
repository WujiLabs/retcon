# Working with retcon (proxy)

## Versioning + commit cadence

- Commit incrementally as you work — small, focused commits are fine and encouraged.
- **Do NOT bump the package version on every commit.** Versions track shipped releases, not in-progress edits.
- Version bumps happen at the END of a release cycle, AFTER:
  - The user reviews the cumulative changes
  - The CHANGELOG has been written for the bump
  - Affected docs (README, INSIGHTS.md, IMPLEMENTATION.md) have been updated
- That single "bump + docs" commit is the release commit. Push that one with the user's go-ahead.
- If a previous version was bumped but not yet published to npm, prefer continuing on it (more commits at the same version) over bumping again. Only bump again when something has actually been published.

## Pushing

- Don't push immediately after every commit while a fix is still in iteration. The user reviews before pushing.
- When the user explicitly says push, push to both `playtiss-public` master AND sync to the standalone `~/retcon` repo (subtree-split + force-push, then re-apply the standalone-repo package.json patches).

## Test discipline

- Unit tests (`pnpm test`) — fast, run on every change.
- Integration tests (`RETCON_TEST_INTEGRATION=1 pnpm test src/test/cli-tmux-integration.test.ts`) — slow, run before the release commit. Some test 3 flakiness is "AI didn't invoke the tool" not retcon's fault.
- For tmux-driven probes (manual debugging), kill the daemon and tmux server first to avoid stale state interference.
