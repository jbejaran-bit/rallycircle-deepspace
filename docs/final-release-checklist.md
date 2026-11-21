# Final release gate

- [ ] Pin the review SHA and verify GitHub Actions on that exact SHA. Keep the integrated `9a032ca` fallback intact.
- [ ] In the approved disposable DeepSpace app, use two independent accounts to test OAuth and invite return, rally creation and join, host edit, chat delivery, Courtboard synchronization and reconnection, scoring and both confirmations. Use a third account for a live full-capacity waitlist promotion.
- [ ] For the [60-second reviewer demo](reviewer-demo.md), confirm that a fourth distinct account changes both open doubles views to **Doubles ready!** without a reload.
- [ ] Verify a participant cannot cancel or score as host, an unrelated player cannot review the result, and signed-out visitors cannot act. Recheck result privacy, stale revisions and legacy attendance fixtures. Browser screenshots and local harnesses do not establish live authorization.
- [ ] Check the invitation, rally details and scoreboard on mobile and desktop. Verify keyboard focus, overlays, error recovery and long names. Use the existing signed-out visual evidence for the public surfaces.
- [ ] Rehearse the [2½-minute recruiter demo](integrated-release.md) with disposable data. Show join, a live update and final confirmation. Explain which environments were verified.
- [ ] Obtain explicit owner approval before any merge, deployment, production migration or submission.

The attendance review fixes legacy duplicate RSVP rows consuming capacity and surviving withdrawal. Score and Account UI work belongs to Copilot. Include it only after the exact changes and authenticated rehearsal can be reviewed.
