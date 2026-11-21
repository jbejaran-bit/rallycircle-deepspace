# RallyCircle final product handoff

Review branch `feature/codex-complete-rallycircle` starts at PR #13's published head `15c602045f0efc2e92fa914e7a5d7d1f36830636`. The Muse review and original release candidate remain at `2c2d24f93daf751108986a45cba1ccb5440044ec` and `236912f44cd2a088edf2de0b834b193d1ac56bec`. [Review comparison](https://github.com/jbejaran-bit/rallycircle-deepspace/compare/feature/codex-professional-product...feature/codex-complete-rallycircle?expand=1)

| Increment | Implemented | Evidence and limits |
|---|---|---|
| `3b61788223b340304565fd1d243e83095112282b` | Next confirmed or hosted rally, community games needing players, section links on rally details, calendar description and eligibility, approval progress, live-score revision feedback, and duplicate chat-submit protection. | Offline tests cover real-record selection, calendar eligibility, stable UID, daylight-saving time, and result visibility. Authenticated updates and reconnect behavior remain unverified. |
| `8efb445d64b67ab3cb20111cfcb17f9934a44d0c` | Inline RSVP and waitlist actions through existing commands, locality-aware distance matching, a prominent court link, and a public explanation of scoring and history. | Offline tests cover eligibility and ambiguous venue matching. Public Chromium checks the new court link and 320–1440 px layouts. The authenticated collaboration spec now exercises inline RSVP, actual calendar bytes and consecutive score updates. |

## Verification

Passed TypeScript, lint, production build, 123 Vitest tests, 31 Node tests and 22 public Chromium tests. Against the built app served by local Vite preview, six browser smoke tests and three signed-out API checks also passed. The Playwright authenticated configuration discovered 19 tests. `npm test` stopped before execution with `not_authenticated`.

```sh
npm ci
npm run validate
npm run lint
node --test tests/*.test.mjs
npm run build
npm run test:public
npm test
```

Chromium used the system executable through `DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`. The cloud runs used a writable `XDG_CONFIG_HOME` and a `WRANGLER_LOG_PATH` under `/tmp`. Real public screenshots are in `/workspace/shared/rallycircle-final` as `landing-desktop.png`, `landing-tablet.png`, `landing-mobile.png`, and `courts-sign-in-mobile.png`. The last screenshot shows the signed-out court gate.

## Integration and release boundaries

The fetched GitHub review refs and available attachments contained the earlier Muse tracks. The seven advanced bundles and the two advanced contract documents were absent. Persistent editable profiles, corrected results, rating, social discovery, polls, recurring sessions, clubs, tournaments, and notifications remain pending those contracts. The current account view and existing tennis workflows remain available under their existing authorization. No new schemas, migrations, dependencies, server permissions, or credentials were introduced by this branch.

Before a release, validate the prior additive schema in an authorized DeepSpace test instance, provider connectivity and OAuth return paths. Recheck GitHub review status and obtain release approval. These results describe a development branch and local Worker, with production deployment outside this work.

## Demo rehearsal

1. Start at the public landing, open **Find a game** or **Explore courts**, and verify the destination after sign-in.
2. Plan a disposable rally from a known court. Invite a second account, RSVP from Find Games, download the calendar event, and check the dashboard's next rally. A third account can exercise the full-session waitlist.
3. Open chat and Courtboard, start a score, and record consecutive points. Confirm the result with the recorded players and check their match history. Clean up the disposable test session.

Only the signed-out portions of this rehearsal were exercised in this environment.

## Next five tasks

1. Run the authenticated collaboration, API, and Courtboard suites using authorized SDK accounts.
2. Verify the prior additive schema and rehearse a three-account capacity and FIFO waitlist scenario.
3. Verify real OAuth return and court-provider recovery from an authorized preview environment.
4. Import Muse's advanced bundles on isolated review branches in the documented order once the files are available, starting with reliability and profiles.
5. Complete a signed-in mobile accessibility and match-correction rehearsal before integrating any experimental rating or competition work.
