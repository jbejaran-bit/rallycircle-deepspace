# RallyCircle — release evidence and submission handoff

**Pinned candidate:** `review/rallycircle-membership-import-green` at `1e19e3eb800f6ab79f1b9e3ae7b42829fef3989c`.
**Review PR:** [draft #27](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/27) (based on the attendance branch, not `main`).
**Exact-head CI:** [Validate RallyCircle run 44971021471](https://github.com/jbejaran-bit/rallycircle-deepspace/actions/runs/44971021471) — success.
**Fallbacks:** `2aa22446a24fdba1cff1fa3ee7844367bea3d4e3` (before the legacy-membership fix), `3d0ac512a5923fe41bec162c910284c9d9319935` (reviewer experience), `9a032ca3b7bd85db5eb9b1fb10544a4c8ebf0ace` (integrated fallback).

## What is implemented

- Court and rally discovery, singles/doubles session creation and invitations, server-side attendance and FIFO waitlists, chat, shared Courtboard, match scoring and confirmation, history, statistics, polls/recurrence and local calendar `.ics` export.
- DeepSpace primitives: sign-in, synced records/subscriptions, messaging, presence and serialized Durable Object command processing. The client and server contain authorization, stale-write and malformed-record checks.
- The corrected legacy attendance path prioritizes valid Going membership over conflicting Maybe/invalid legacy rows and releases seats on withdrawal or Maybe downgrade. The follow-up commit only changes three runtime import specifiers from `./rally` to `./rally.ts` for Node type stripping.

## Evidence and limits at the pinned SHA

| Evidence | Result | Meaning |
| --- | --- | --- |
| GitHub Actions at `1e19e3e` | **Passed** | Exact-commit automated validation, not a deployment or authenticated runtime test |
| Independent Windows run of the three-line import patch | **403/403 Vitest, 35/35 Node**, TypeScript/lint/build pass | The identical source-level patch was locally tested on the same parent; the local patch was committed under a different SHA |
| Public Chromium suite on the prior `3d0ac51` candidate | **38/38 passed** | Signed-out/public browser flow evidence; not rerun and not claimed as an independent local run on this pinned SHA |
| Legacy Going/Maybe regression | **Passed in local mock harness** | Tests canonical roster and seat handling including withdrawal/Maybe switch/FIFO; does not establish hosted latency or RecordRoom behavior |
| DeepSpace OAuth and multi-account | **Not run** | Two test accounts exist, but separate app registration returned `app_quota_exceeded`; production-linked identity is not a safe substitute |
| Real Durable Object alarm, legacy data migration, long histories | **Not verified live** | Mock/fault-injection evidence only; no production migration performed |

## Catalog integrations: accurate inventory

This candidate invokes **zero named DeepSpace catalog provider endpoints**. `src/integrations.ts` specifies account/billing behavior for Google and Composio but is **not evidence that a provider endpoint is used**. Direct Overpass/Nominatim court discovery and client-generated `.ics` files are not catalog calls. The original private assignment/rubric has not been verified here, so no three-integration requirement is asserted or claimed satisfied. Obtain the private brief before making a compliance claim or approving billable integrations.

## Reviewer path without a live test environment

1. Open the [README](../README.md) and its two genuine signed-out application screenshots, then the [60-second demo script](reviewer-demo.md).
2. Explain the user journey — find a court → create/share a rally → RSVPs and waitlist → chat/Courtboard → score and confirm — distinguishing implemented code from live, unverified collaboration.
3. Show reproducible automated evidence and the single real defect found in legacy duplicate attendance, plus its regression and Node import repair.
4. If an approved isolated test environment becomes available, run the [two-account evaluation](reviewer-demo.md#two-account-evaluation-path-when-approved), then the four-account doubles readiness and three-account waitlist promotion checks. Capture failures accurately; don't substitute screenshots of signed-out routes for these checks.

## Owner actions before submission

- [ ] Read the original private DeepSpace assignment and confirm eligibility, required catalog integrations, submission format, exact deadline and whether a deployed URL is mandatory.
- [ ] Confirm which reviewed Git SHA and repository link the application should cite; do not silently substitute `main` for the pinned review branch.
- [ ] Decide whether a hosted deployment is required, feasible and approved. **No deployment or production mutation is authorized by this document.**
- [ ] Resolve disposable-app quota through approved provider channels if authenticated demonstration is required, or disclose the blocked live checks transparently.
- [ ] Personally review the README, screenshots and 60-second path. Do not claim to have run OAuth, live collaboration or a recorded video unless actually done.
- [ ] Complete the final writeup in your own voice: rationale, architecture, meaningful DeepSpace use, security/tradeoffs, what coding agents contributed, what you reviewed, what's unverified and what you'd improve next.
- [ ] Submit only after explicit owner approval and retain the submission confirmation.

**Release decision:** Code-review candidate with passing CI; live/authenticated release gate still open. No merge into `main`, production deployment, data migration, app deletion, payment or internship submission has been performed.
