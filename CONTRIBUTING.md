# Contributing to Callisto

Thanks for helping. This project favors small, sharp diffs and honest numbers.

## Ground rules

- **Design changes get an RFC first.** Non-trivial surface changes (a new Mini
  method, the a11y-tree format, the agent prompt, a tool) start as a one-page
  RFC in [`rfcs/`](rfcs/). Copy the numbering pattern. Discuss, then build.
- **Two tools, no more.** The agent loop has exactly two tools (bash + a JS
  REPL). PRs that add a third will be closed with a link to the RFC process.
- **No new dependency for what a few lines can do.** Justify every dependency
  in the PR description.
- **Numbers must be reproducible.** No benchmark claim lands without the kit
  and pinned versions that produced it.

## Workflow

1. Open (or comment on) the phase-tracker issue for the phase you're touching.
2. Branch from `main`. Keep the branch scoped to one change.
3. Use [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
4. Make CI green: `npm run typecheck` in `packages/mini` (and `pytest` once the
   harness exists).
5. Open a PR. Describe *what* and *why*, link the issue/RFC.

## Local setup

```bash
cd packages/mini
npm install
npm run typecheck
CALLISTO_SMOKE=1 npm test    # network + local Chrome required
```

## Good first issues

Look for the `good first issue` label. If you're new, say hi in the issue
before starting so we don't double up.

## Code review

Reviews are direct but kind. We reject slop, not people. If your PR is asked to
shrink, that's the house style, not a judgment.
