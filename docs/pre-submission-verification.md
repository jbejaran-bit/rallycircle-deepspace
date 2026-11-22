# RallyCircle submission review

This is the historical review for PR #20 and stabilization commit `d7270b1`. Follow the [current release checklist](final-release-checklist.md) and [reviewer demo](reviewer-demo.md) for the integrated candidate.

**Decision:** Hold production deployment and submission. The stable review path starts from the stabilization commit `d7270b1`. Rehearse it with authorized accounts in a disposable DeepSpace app before deciding whether to deploy. PR #20 at `f492736` remains the advanced review path. Deadline is November 23, 2026 at 11:59 PM Eastern unless the program confirms an extension.

## Verification matrix

| Workflow | Stable branch | Evidence and limits |
| --- | --- | --- |
| Landing, protected navigation, keyboard and responsive layout | Included | Public Chromium and local build |
| Discover courts and games | Included | Local business logic and public navigation. Live location and signed-in discovery need rehearsal. |
| Sign in, create and join rallies, attendance and waitlists | Included | Local action and permission tests. Verify identity, record persistence and three-account promotion in DeepSpace. |
| Session chat, Courtboard, scores, and result confirmation or dispute | Included | Local rules and existing browser specs. Run authorized multi-account browser tests for live state, privacy and reconnection. |
| Calendar export | Included | Local calendar tests. Import an export during rehearsal. |
| Player-profile editing, verified history and statistics, correction and audit | Held on PR #20 | Local projection and fault-injection tests. Real migrations, multi-account action permissions and long-history request cost need rehearsal. |
| Scheduling polls, notification inbox, recurring rallies and automatic recovery | Held on PR #20 and the isolated time-write review | Local command tests and mocked restart. Actual alarm execution and live delivery need rehearsal. |
| Rating, social graph, clubs and tournaments | Experimental | Separate review branches. |

## Evidence

Git advertised PR #20 at `f49273616e7c834a1c20473bf85a7db9c524f735`. The operator reports CI passed. Its `Validate RallyCircle` workflow runs the dependency install, TypeScript/Vitest, lint, the Node business-logic suite and public Chromium. GitHub GraphQL returned `Forbidden`, and the REST check-runs endpoint was blocked by the network tunnel, so CI job IDs, attempt number and remote logs remain unverified here. The PR #20 workflow does not run the production build, authenticated tests or live migrations.

Fresh local checks on `d7270b1` passed TypeScript, lint, the production build, 148 Vitest tests across 20 files, 31 Node tests and 22 public Chromium tests. The toolchain was Node 24.22.1, npm 11.9.0 and Chromium 156.0.8078.79. The stable branch adds this review document to that tested code.

Historical note: the initial PR #20 review did not yet have a Muse audit artifact visible to that workspace. Muse's subsequent backend delivery at `6bddf04` is incorporated into the integrated candidate lineage; see [current release evidence](submission-handoff.md).

## Blockers and isolated follow-up

- DeepSpace sign-in and a disposable app block verification of legacy upgrades, live Durable Object alarms, and multi-account flows. Signed-out browser coverage and RecordRoom harnesses do not establish live correctness.
- The time-write review off PR #20 moves creation to an authenticated action and closes SDK client writes to `startsAt`. Verify creation, chat linking and poll finalization in the disposable app before promotion. Existing clients need matching Worker and frontend assets when the permission change ships.
- Large match histories still require one session lookup per indexed result. The local pagination test passes beyond 500 results, but the request budget and latency in the hosted runtime are unknown. The advanced history and statistics surfaces are outside the stable branch.

## Operator sign-in and disposable test setup

From a local terminal in the repository, use the official CLI prompt. Complete the login yourself, without sharing your production password or test account files in chat.

```sh
npx deepspace auth login
npx deepspace auth whoami
npx deepspace test accounts list --usable
```

Regular DeepSpace accounts sign in through GitHub or Google OAuth in a browser. The CLI password flags apply only to test and internally provisioned accounts. Run the rehearsal on the signed-in workstation unless the cloud workspace has an approved private session mount. Keep the owner session file out of Git, chat, and uploads. When the owner session works, use an existing authorized pool or let the owner create three dedicated test identities. Example command, repeat with unique email and label:

```sh
npx deepspace test accounts create --email="$RALLYCIRCLE_TEST_EMAIL" --label=host --password-stdin
```

Set `RALLYCIRCLE_TEST_EMAIL` to a unique address ending in `@deepspace.test` for each account. Use labels `host`, `player`, and `waitlist`, and supply each test password on stdin. The CLI fixture stores the pool in `~/.deepspace/test-accounts.json`. Keep this file private and outside Git. Confirm a disposable app is available and approve any required test deployment separately before proceeding. Check the app ID, hostname, account roles, backing storage, and migration data source. Use a synthetic legacy fixture. Do not point these tests at the internship or production app.

For a configured local Worker slot, use `npx deepspace test run all --env "$RALLYCIRCLE_DISPOSABLE_SLOT" --secrets-config "$RALLYCIRCLE_DISPOSABLE_CONFIG"`. For an already provisioned disposable preview, run:

```sh
RALLYCIRCLE_TEST_URL="$RALLYCIRCLE_DISPOSABLE_URL" npx playwright test -c tests/playwright.config.ts
```

Set these variables to your approved slot, secrets config, or HTTPS preview URL. Run only after verifying the target. The current worker session has no authorized DeepSpace login or test-account pool. Official references are the [CLI commands](https://docs.deep.space/cli-reference/commands#test-accounts), the [testing guide](https://docs.deep.space/guides/testing), and the [schema migration guide](https://docs.deep.space/agents/add-field-existing-app-without-losing-data).

## Interview demo and rehearsal

1. On desktop and mobile, open the site, sign in as the host, create a future rally and share its invite.
2. Open the invite as another player, or find the session in Games. RSVP and verify that both browser contexts update. Fill capacity, join the waitlist from a third identity, and withdraw one confirmed RSVP to observe promotion.
3. Exchange chat messages and reconnect a browser. Open Courtboard with an authorized player and check that an unrelated account is denied.
4. Start singles scoring, make a stale point request from a second tab, then finish and confirm or dispute from the two recorded players. Check Dashboard and import the calendar download.
5. On a separate disposable advanced preview, rehearse corrections, history, statistics, polls, notification reads and recurring series. Force a recoverable interruption and verify that the alarm completes the same operation without duplicate rows. Check concurrent time writes, legacy session rows, and realistic long result histories before promoting these features.

## Deployment checklist

- [ ] Confirm the approved app slot and branch SHA. Record the current release and rollback target.
- [ ] Pass the authorized smoke, API, and E2E suites and the manual rehearsal. Record the host, player and third-account outcomes without storing personal credentials.
- [ ] Rehearse the candidate upgrade with disposable legacy records. Confirm the rollback data and schema requirements.
- [ ] Review signed-in mobile and desktop behavior, permissions, and the rollback plan.
- [ ] Obtain explicit approval, then deploy the approved candidate and run smoke checks under that approval.

## Submission checklist

- [ ] Confirm the official deadline and gather the required repository and app links.
- [ ] Verify the exact reviewed commit and record the tests, screenshots and known limitations.
- [ ] Walk through the stable demo above using disposable data. Keep advanced previews labeled.
- [ ] Obtain explicit approval for submission and retain the confirmation afterward.
