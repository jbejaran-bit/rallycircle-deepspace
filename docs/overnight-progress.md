# RallyCircle product sprint

Kickoff November 21 at approximately 12:52 AM Eastern. User window ends approximately 10:52 AM Eastern. Goal activation returned `active`. Backlog retrieved from GitHub issue #24 through the public issue page after GraphQL was forbidden.

The umbrella stable review worktree is `/workspace/rally-overnight-product`, branch `review/rallycircle-overnight-product`, based at `d06b1a9`. Advanced UX starts at PR #22 `e6ff2d9` and stays separate. PR #21, main, production, and Muse's backend work are outside these changes.

| Package | Owner | Evidence |
| --- | --- | --- |
| App chrome, auth, onboarding, accessibility | root | Sign-in dialog and skip link implemented. Browser verification underway. |
| Landing and identity | design | Isolated work in progress. |
| Games and courts | discovery | Isolated work in progress. |
| Dashboard | dashboard | Isolated work in progress. |
| Rally/attendance/score/chat/Courtboard | matchday | Isolated work in progress. |
| Advanced profile, scheduling and inbox | advanced | Isolated work in progress. |

On continuation, read this ledger and check branches and agent status before repeating work. Bring independent stable commits into the umbrella review branch and rerun all applicable checks. Capture all six requested widths and keep signed-out evidence distinct from authenticated previews. Add recruiter demo and traceable test outputs. Avoid relying on generated fixture accounts or production as a rehearsal.

DeepSpace authenticated verification needs a separate approved disposable app. Issue #24 reports reusable owner accounts and `app_quota_exceeded` during owner provisioning; no authorized cloud rehearsal target was supplied. Do not deploy or change credentials.
