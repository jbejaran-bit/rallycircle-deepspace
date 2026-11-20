# RallyCircle demo guide

## Which build to show

Use an authorized local development instance for the Ready to Play demo. Verify the exact Git revision and run `npm run validate` and `npm run test:public` first. For the live walkthrough, run `npx deepspace auth whoami` and `npm run dev -- --host 127.0.0.1`, then confirm `/api/auth/ok` on the local origin. Open two separate browser profiles to keep the host and participant sessions independent.

| Capability | Published source | Demo status |
|---|---|---|
| Landing, sign-in UI, session board, chat, presence, court finder | Base app on GitHub | Public UI exercised in cloud. Rehearse authenticated flows in an authorized instance. |
| Readiness, RSVP action, host-only cancellation | GitHub draft PR #2 | Branch workflow. Latest cloud login was unavailable. |
| Quality and reliability changes | `codex/ready-to-play-quality` | Public and offline checks passed. |
| Live Courtboard | GitHub draft PR #5 stacked on PR #2 | Offline checks passed. Show live only on an authorized build after its integration suite passes. |
| Scoreboard and editable chat profiles | No published source confirmed in this review | Leave out of the live walkthrough until available and verified. |

The Git main branch is not evidence of the deployed revision. Confirm the release status and then verify the exact URL and features before presenting anything as live. [PR #2](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/2) · [PR #5](https://github.com/jbejaran-bit/rallycircle-deepspace/pull/5)

## Walkthrough

1. Start at the landing page and follow the call to action. Show that a signed-out visitor opening a shared Rally sees the sign-in gate.
2. Sign in with Google using an authorized demo identity. Open **Courts**, select a venue, and explain that RecDesk supplies the permit calendar. **Plan a Rally here** prefills the venue and area. If browser location is denied, select courts from the list.
3. Create a future session, choose a target of three, and show the session details. The host's RSVP will normally make the initial count one. If the host RSVP failed, explain the warning and retry with **I’m in**.
4. Share the session URL with the second browser. Sign in with a separate identity and confirm the invitation lands on the same session. Join and show the host's count update to two without refreshing, with one more confirmed player needed for the target.
5. Exchange a short chat message and verify its arrival in the second browser. Show the presence count while both browsers have the session open.
6. Withdraw in the second browser and observe the count decline. Cancel as the host and verify the participant sees cancellation and cannot submit a new RSVP.
7. If the relevant Courtboard branch and two-account suite have been verified, use its eligible viewer/editor accounts to place and move an item, observe the other browser, then show the read-only state after cancellation. Run this before cancelling or with a separate disposable session.
8. Cancel any remaining disposable demo sessions as their respective hosts.

## If the deployment is still stuck

Show the public UI and offline test results first. Use a previously verified local authenticated demo only if your environment is authorized and working that day. Describe the release as pending verification, and separate the branch checks from production behavior.
