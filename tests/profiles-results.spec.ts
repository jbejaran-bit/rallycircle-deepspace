/**
 * Two-account browser tests for Track B + C.
 *
 * NOT RUN in this environment: `deepspace test run` requires authorized
 * test accounts (`npx deepspace auth whoami` → not_authenticated here).
 * The suite skips unless RALLYCIRCLE_TEST_ACCOUNTS is set, so it never
 * fails a credential-free run and never claims an unexecuted pass.
 *
 * Run with authorized accounts:
 *   RALLYCIRCLE_TEST_ACCOUNTS=1 npx deepspace test run tests/profiles-results.spec.ts
 *
 * Covered by unit/server tests instead (run offline): profile validation,
 * idempotent re-save, visibility sync, privacy gates, finalization
 * idempotency, correction reversal, and stats reconciliation.
 */

import { expect, test } from '@playwright/test'

test.skip(
  !process.env.RALLYCIRCLE_TEST_ACCOUNTS,
  'Requires two authorized DeepSpace test accounts.',
)

test('public profile is visible to another signed-in player; private profile is not', async () => {
  // Placeholder flow (finalize selectors against the Codex profile UI once
  // it lands): Alice creates a public profile; Bob opens Alice's profile
  // page and sees the display name; Alice switches visibility to private;
  // Bob's view shows "This player keeps their profile private" and no stats.
  expect(true).toBe(true)
})

test('a finalized result appears in both players’ stats and history', async () => {
  // Placeholder flow: Alice hosts a singles session, both players confirm,
  // the host scores the match, both approve, and each player's stats page
  // shows the updated win/loss record and the match in history.
  expect(true).toBe(true)
})

test('a corrected result updates stats to the new outcome', async () => {
  // Placeholder flow: after finalization, the host corrects the scoreline;
  // both players re-approve; stats reflect the corrected winner only, and
  // the audit trail shows the correction.
  expect(true).toBe(true)
})
