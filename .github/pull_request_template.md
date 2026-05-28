## What
<!-- One sentence describing what this PR changes. -->

## Why
<!-- The problem this solves or the motivation. Link the issue if one exists. -->

## Type
- [ ] Bug fix
- [ ] Feature
- [ ] Refactor (no behaviour change)
- [ ] Docs
- [ ] Accessibility
- [ ] Performance
- [ ] CI / chore

## How I verified
<!-- How did you confirm this works? "Tested in browser" is not enough — say what you clicked. -->
- [ ] Hard-refreshed and tested the full flow: CALIBRATE → slouch → alert fires → recovery logs as `corrected`
- [ ] Tested at least one non-Chromium browser (Safari or Firefox)
- [ ] DevTools console is clean of new warnings/errors
- [ ] No regression in alert timing (2s persistence, 30s ignored threshold)
- [ ] `localStorage` data still loads correctly on reload

## Checklist
- [ ] No new runtime dependencies (project is vanilla JS, no build step)
- [ ] CSS uses existing tokens (`--text-*`, color vars) where applicable
- [ ] Comments are minimal — only the WHY when behaviour is non-obvious
- [ ] A11y not regressed (`aria-*` attributes, `prefers-reduced-motion`)
- [ ] README updated if user-facing behaviour changed

## Out-of-scope reminder
This project intentionally excludes distraction detection, gaze tracking, cloud sync, and backend logic. If your PR touches those, please open a Discussion first.
