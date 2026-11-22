# Final release gate

- [ ] Review `3d0ac512a5923fe41bec162c910284c9d9319935`. [GitHub Actions passed for this exact SHA](https://github.com/jbejaran-bit/rallycircle-deepspace/actions/runs/44963039744). Keep `9a032ca` as the fallback and verify CI again for any replacement SHA.
- [ ] In the approved disposable DeepSpace app, use two independent accounts to test OAuth and invite return, rally creation and join, host edit, chat delivery, Courtboard synchronization and reconnection, scoring and both confirmations. Use a third account for a live full-capacity waitlist promotion.
- [ ] For the [60-second reviewer demo](reviewer-demo.md), confirm that a fourth distinct account changes both open doubles views to **Doubles ready!** without a reload.
- [ ] Verify a participant cannot cancel or score as host, an unrelated player cannot review the result, and signed-out visitors cannot act. Recheck result privacy, stale revisions and legacy attendance fixtures. Browser screenshots and local harnesses do not establish live authorization.
- [ ] Use disposable legacy fixtures to check mixed Going/Maybe duplicates, schema upgrades, actual Durable Object alarm recovery, and large match-history queries. The current server can count a seat from a Going row while the UI keeps the first valid response. Withdrawing clears the caller’s duplicate rows within the cleanup bound. Verify rejoining, FIFO promotion, and the resulting roster.
- [ ] Check the invitation, rally details and scoreboard on mobile and desktop. Verify keyboard focus, overlays, error recovery and long names. Use the existing signed-out visual evidence for the public surfaces.
- [ ] Rehearse the [2½-minute recruiter demo](integrated-release.md) with disposable data. Show join, a live update and final confirmation. Explain which environments were verified.
- [ ] Obtain explicit owner approval before any merge, deployment, production migration or submission.

The attendance review fixes legacy duplicate RSVP rows consuming capacity and surviving withdrawal. Score and Account UI work belongs to Copilot. Include it only after the exact changes and authenticated rehearsal can be reviewed.

The reviewer SHA already contains Muse’s `6bddf04` backend through ancestry. The catalog audit found zero provider endpoint calls. Confirm the required integration count from the original assignment before adding paid integrations or claiming rubric compliance.
