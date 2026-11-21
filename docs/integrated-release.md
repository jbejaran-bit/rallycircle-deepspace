# Integrated RallyCircle candidate

This review starts from the original Muse delivery at `6bddf04` (PR #22 ancestry) and adds the professional product from `e2d2c86`, compatible dashboard data-integrity fixes from PR #25 through `8239b5e`, and the advanced frontend from `79b2d22`. PR #21 remains the fallback. The patch archive was an alternate delivery and was not applied.

## Two-and-a-half-minute recruiter demo

Run this on an approved disposable DeepSpace app. Use two signed-in browser profiles, plus a third test account if demonstrating a waitlist.

1. **0:00–0:25** Open the landing page, follow Find Games, and show the sign-in gate. Switch to the signed-in host’s dashboard.
2. **0:25–0:55** Find a court and create a future singles rally. Share its invite and join as the guest. Use a capacity of two if rehearsing waitlist promotion.
3. **0:55–1:35** Send a chat message and move a Courtboard marker. View the update from the guest browser. If a third account is available, join the waitlist and withdraw the guest to demonstrate promotion.
4. **1:35–2:30** Start scoring and record a point. Open a disposable completed match and approve it from both accounts. Return to the dashboard. Explain per-session command serialization and how only committed, confirmed results count toward statistics.

When the runtime is unavailable, use the real public-flow captures and describe the sign-in and multi-account path as a rehearsal plan. Use the preview only for advanced features after live validation.

## Authenticated verification still required

- Confirm OAuth callback and invite return path. Confirm two-account rally creation, including resubmitting the same draft, host-only edits, and cancellation.
- Verify Find Games and court discovery with real data, including location denial. Join and withdraw in two sessions. Use a third account to verify FIFO promotion and capacity under simultaneous requests.
- Exchange chat, check access isolation and reconnect behavior in Courtboard, and test score revision conflicts, confirmation, dispute, and authorized correction.
- Verify private profile and history access, pending correction labels, poll votes and finalization, calendar updates and cancellation, inbox delivery, and recurring-series permissions.
- Use disposable legacy fixtures to validate schema upgrades and alarm recovery. Exercise large histories and notification counts. The inbox still uses the backend’s bounded mark-all scope and reports the actual count updated.

`deepspace test run all` refused with `not_authenticated`. The test harnesses and public Chromium suite provide local evidence. They do not verify the live OAuth, two-account, or migration paths. See [disposable environment setup](pre-submission-verification.md).
