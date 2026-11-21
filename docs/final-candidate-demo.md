# RallyCircle in 2½ minutes

Rehearse against an approved disposable DeepSpace app. Sign into three separate test browser contexts as host, guest and waitlist player. Seed only the rally and scores required for the demonstration. Keep the public and signed-in browser contexts separate.

| Time | Show |
| --- | --- |
| 0:00–0:20 | Start on the public landing page. Open Find Games and show the sign-in dialog. Switch to the signed-in host's Dashboard. |
| 0:20–0:50 | Find a court, open its map or official listing, and choose **Plan a Rally here**. Create a future singles rally with capacity two, then share its URL. |
| 0:50–1:20 | Join from the guest browser. Show the count update on the host's screen. Join the waitlist from the third browser, then withdraw as the guest to show promotion. |
| 1:20–1:55 | Send a chat message and move one Courtboard marker. Show the update in the other context. Download the calendar entry. |
| 1:55–2:30 | Start the singles match, record a point, then open a prepared disposable result awaiting confirmation. Explain server-side authorization, capacity serialization and score revisions. End on the Dashboard. |

Run the rehearsal once on mobile and desktop. If the authorized runtime remains unavailable, show the signed-out browser recording or screenshots, then walk through the local test evidence. Label the dashboard and discovery fixtures as layout evidence. Keep advanced profiles, result projections, polls and tournaments outside the stable demo.

## Reviewer notes

- This branch starts at `38a9b2a` and incorporates PR #25 through `f9cf998`. [PR #25 CI](https://github.com/jbejaran-bit/rallycircle-deepspace/actions/runs/44942464403) is evidence for that upstream head.
- K01 follows the published Muse contract. Both command-room callers attach the internal marker. Public actions still authenticate through the Worker and authorize the session operation. The marker adds an internal boundary check.
- Muse's unpublished `e1e0d57` consolidation is outside the candidate. No advanced schemas or transport changes from that branch were imported. Rehearse compatibility once that commit is available for review.
- Use the [release verification packet](pre-submission-verification.md) for disposable setup, multi-account tests and deployment approval. Current recommendation is review and rehearsal before deployment.
