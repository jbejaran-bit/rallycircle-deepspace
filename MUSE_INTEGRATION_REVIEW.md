# Muse bundle integration review

The integration branch starts at `236912f44cd2a088edf2de0b834b193d1ac56bec`. Each bundle passed `git bundle verify`, was fetched into its own branch without rewriting commits, and passed Git object connectivity checks. These checks establish archive integrity and ancestry.

| Source branch | Bundle tip | Integration decision |
|---|---|---|
| `review/muse-capacity` | `ff0c32170fe3e8f7e3b1559a8daf02364eea8ef9` | Adapted serialized withdrawal, waitlist membership and FIFO promotion. Kept the release candidate's optional immutable capacity field. |
| `review/muse-scoreboard` | `cff28429583686014a71a6042a68461e1fd33a1d` | Kept the release candidate's point-by-point scoring and participant result confirmation. Muse also gates writes to the host and rejects stale revisions. Its separate score collection and manual score-entry form would introduce another source of truth. |
| `review/muse-calendar-fixes` | `7ac691295c8b3d17594ebe4d311cc07f8cec3d5e` | Kept the existing calendar event format, stable UID and confirmed-player eligibility. Adopted session field length limits, action error handling, chat-link retry and idle time refresh. The scheduling poll prototype remains on the source branch. |
| `review/muse-courts` | `3a107e25acce80b437873ba98ed0377056e5cd7b` | Integrated nearby and place search, mapping and Find Games. The existing Pittsburgh court list, search and verified booking links remain the default tab. |
| `review/muse-courtboard-nudge-fix` | `f8f919f9cf61cf8b8bb68f4005e49b58aab183e1` | Applied the keyboard and button nudge fix against the existing secured Courtboard. |

The debugging-lab archive contains separate challenge snapshots and answer keys. It was listed for identification and was not executed or imported.

## Behavior and release checks

- Members can join a full session's waitlist. The existing command room processes queue entries in creation order and can promote a tentative RSVP in place. Waitlist records are private to their owner for normal member reads. App clients withdraw through the action so that the freed place can trigger promotion.
- A promotion can save its RSVP before queue cleanup. The next attendance command repairs that intermediate state. No background retry is scheduled after a provider or storage failure. A known queue failure blocks a new confirmation while waitlist priority cannot be checked.
- Find Games uses explicit formats and capacity when present. Old sessions retain target-based format inference. Distance results require a known court match. Nearby search sends coordinates rounded to three decimal places following a location request. Court results are mapped facilities, and availability and reservations remain with the venue.
- Geocoding uses a shared Durable Object and a persisted admission timestamp to pace requests across Worker isolates. Validate the selected OpenStreetMap providers, service policy and outbound connectivity in an authorized test app. The signed-out path and fixture responses are covered here.
- The waitlist collection is additive. Recheck its schema registration and rollout ordering with the new client and Worker in the authorized environment. Validate signed-in discovery, consecutive score updates, Courtboard nudges with latency, and three-account waitlist promotion before release.

PR #11 remains a draft on the published release candidate. This integration is on a separate review branch.
