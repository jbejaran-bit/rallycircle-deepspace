# RallyCircle release candidate

Branch `integration/rallycircle-release-candidate` integrates Ready to Play, Live Courtboard, and the quality and handoff work. It is a review branch. No production release or submission was performed. [GitHub comparison](https://github.com/jbejaran-bit/rallycircle-deepspace/compare/main...integration/rallycircle-release-candidate?expand=1)

## Source branches

| Branch | Published commit | Integration |
|---|---|---|
| `main` | `d7c96ead8909c79a6d83a0c19cecca7b9429d43a` | Older baseline for the review diff |
| `feature/ready-to-play` | `8fd8c2cfe08b2f1e766c92765ed7ab56740c003e` | Integration base, PR #2 |
| `feature/live-courtboard` | `a72c6330b2cea447b6f0cc418a5de44c3d5ba7b2` | Cherry-picked with the authorization and Canvas tests, PR #5 |
| `codex/ready-to-play-quality` | `451da3a872df495e2e6faead19f83b0f702a6952` | Cherry-picked with CI and regressions, PR #9 |
| `codex/ready-to-play-handoff` | `ce31352eaad2eca9334a22f5b074d319a840b2ca` | Cherry-picked with demo, testing, and interview materials, PR #10 |

The fetched public branch and pull-request refs contained no Copilot chat-profile or redesign branch and no Muse gameplay or discovery branch. Those original implementations were unavailable for integration. The new scoreboard, capacity and court search are deliberately scoped release-candidate implementations. Compare their contracts against Muse's changes when published.

## Feature matrix

| Functionality | Status | Evidence and limits |
|---|---|---|
| Public landing, signed-out invite gate, mobile keyboard navigation | Implemented and tested | Credential-free Chromium suite. The menu test now waits for the existing `/home` redirect. |
| Ready to Play, host cancellation, invite, chat and presence | Implemented but not fully verified | Integrated from PR #2. App command and authorization tests passed offline. Multi-account sessions still need authorized runtime validation. |
| Live Courtboard | Implemented but not fully verified | Integrated from PR #5 with its WebSocket authorization. Offline permission and route tests passed. Live snapshot access, sync and revocation tests could not run here. |
| Singles, doubles and practice with calendar export | Implemented and tested offline | `331b17c`, `e2cbed1`. Calendar tests cover UTC, midnight, escaping and UTF-8 folding. The download appears for hosts and confirmed participants in open sessions. Calendar imports do not receive later updates. |
| Court name and area search | Implemented and tested offline | `ad3e7d8`. Uses the verified Pittsburgh dataset already in the app, with filtered map markers, booking links and an empty state. No availability inference and no uploaded geolocation. |
| Singles and doubles scoreboard, Playing Now | Implemented but not fully verified | `aac2ccd`. Host selects distinct confirmed attendees. The command queue persists points, games, best-of-three sets and 6–6 tiebreaks in the session record. Observer UI reads the subscribed record. Offline scoring and authorization passed. Two-browser delivery and reload assertions were added and remain unrun. |
| Optional confirmed RSVP maximum | Implemented but not fully verified | `97617fe`. Maximum is immutable once set. The server serializes joins against going RSVPs. A withdrawal frees capacity for the next successful join. Concurrent command tests passed with fixture storage. |
| Result proposal, confirmation, dispute and finalization | Implemented but not fully verified | `4eb4f00`. Every recorded participant approves before a result becomes final. A dispute locks the result. Offline tests cover verified identity, concurrent approvals, duplicates and disputes. |
| Copilot redesign and chat profiles, Muse original feature branches | Blocked | No published branches or PR heads were found in this review. |
| Automatic waiting list, rating history, feeds, video, dispute resolution | Not implemented | Waiting list promotion needs a coordinated transition with withdrawal. Rankings have no implementation and no result updates a rating. |

## Release checks

- Executed against the release candidate with Node 24 and npm 11. Lockfile install, TypeScript, lint, production build, 51 Vitest tests, 19 Node tests, 13 public Chromium tests and one signed-out HTTP Worker check passed. Authenticated specs were discoverable. The DeepSpace CLI had no authorized session and could not list usable accounts.
- Score and result writes require verified identity and use the same per-session command room as RSVP and cancellation. The scoreboard column is excluded from direct member and admin field writes. Scoring uses revisions to reject duplicate or stale point writes. Self-withdrawal is a separate permission-checked delete. A concurrent withdrawal can cause a conservative full response, which the user can retry, and cannot add a confirmed player. A player may withdraw after being selected for a match. Result authorization remains tied to the recorded match participants.
- The schema adds optional `format`, `capacity`, and `matchScore` columns. Legacy sessions need no backfill. The SDK documents additive migration support, but an actual test-app upgrade still needs validation. Existing Worker bindings, migration declarations, package dependencies and app ID are unchanged. [DeepSpace additive migration guide](https://docs.deep.space/agents/add-field-existing-app-without-losing-data)
- Public screenshots were captured locally in `/workspace/shared/rallycircle-release-candidate` as `desktop-landing.png` and `mobile-invite.png`. Authenticated screenshots remain pending.

## Before any release

1. Review the integration diff and additive schema changes. Compare with any newly published Copilot or Muse branches before bringing them in.
2. In an approved test environment, confirm `deepspace auth whoami`, two usable accounts, and a working local `/api/auth/ok`. Run `npm run test:api`, `npm test -- tests/rally-collab.spec.ts`, and `npm test -- tests/courtboard.spec.ts`. See [TESTING_GUIDE.md](TESTING_GUIDE.md).
3. Verify SQLite schema upgrades against pre-existing test records. Rehearse court search, join, calendar download, live score across two browsers, refresh, and result confirmation. Check a full session with a third account when one is available.
4. Decide on score correction and dispute resolution before using final results for a rating system. Coordinate any waitlist with the withdrawal path and test failure recovery before adding promotion.
5. Confirm the current DeepSpace release status directly. The reported `release_in_progress` issue remains unverified in this environment. Production release and submission require separate authorization.
