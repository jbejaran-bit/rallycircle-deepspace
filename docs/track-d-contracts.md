# Track D — Rating contracts for Codex

**Status: experimental.** The RallyCircle Rating is RallyCircle's own
community rating (algorithm v1). It is **not** a UTR score, **not**
equivalent to NTRP/UTR or any proprietary ranking, and **not** scientifically
validated. Every surface that shows a rating must label it
"RallyCircle Rating (experimental)" and must show the provisional state for
players with fewer than 10 finalized matches in that format.

## Data types

```ts
type RatingFormat = 'Singles' | 'Doubles'

interface PlayerRating {
  playerId: string
  format: RatingFormat
  rating: number            // integer, 100–3000, starts at 1200
  matchesPlayed: number     // finalized matches in this format
  provisional: boolean      // true while matchesPlayed < 10
  /** Share of the provisional threshold reached, 0..1 (matchesPlayed / 10). */
  confidence: number
  algorithmVersion: number  // 1
  lastResultId: string      // `session:<sessionId>:rev:<revision>`
  status: 'experimental'    // always, in v1
}

interface RatingChange {
  resultId: string
  playerId: string
  format: RatingFormat
  algorithmVersion: number
  before: number
  after: number
  delta: number             // signed integer, e.g. +30 / -15
  reason: 'result' | 'reversal'
  explanation: string       // human-readable, e.g. "Beat cara (1400) in singles · expected win chance 26% · K 40 · +30 (player ana)"
  opponentIds: string[]     // opaque auth ids; resolve to display names via profiles (Track B)
  matchesPlayedAfter: number
}
```

Player ids in explanations are opaque auth ids. Resolve them to display
names through the profile layer (Track B) — never show a raw id to users as
if it were a name, and never trust a client-supplied name as the rating key.

## Record ownership and permissions

- Collections: `playerRatings` (one row per player+format,
  `uniqueOn: ['playerId', 'format']`) and `ratingChanges` (append-only, one
  row per result+player, `uniqueOn: ['resultId', 'playerId']`).
- **Server-written only.** Direct client create/update/delete is closed for
  every role. Ratings change only through the server applier
  (`applyFinalizedResultToStore`), which runs with the tools API after a
  result is finalized.
- Reads: any signed-in member can read ratings and rating history (they are
  community-visible, like match results). If Track B makes profiles private,
  rating visibility must follow — that restriction is not implemented here.
- `provisional` is stored as a number (0/1) because schema columns are
  number|text only; the typed API exposes it as a boolean.

## How ratings change (and when they do not)

- Only **finalized** results change ratings: winner set, not disputed, and
  every recorded participant approved. Proposed, partially confirmed,
  disputed, and in-progress results never affect ratings.
- Singles and doubles ratings are independent. A doubles result never
  changes a singles rating.
- A result can never count twice: re-applying the same `resultId` is a
  no-op per player.
- A later correction/invalidation appends a `reason: 'reversal'` record
  carrying the negated delta applied to the player's *current* rating;
  history is never edited. There is no correction workflow in the base yet —
  the reversal API exists for Track C to call when one lands.
- No decay: inactivity never changes a rating.
- K-factor: 40 (0–9 finalized matches), 32 (10–29), 24 (30+); halved after
  3 prior finalized matches against the same opponent. Full formula and
  worked example: `docs/RATING_SPEC.md`.

## Frontend states (what to render)

| State | Render |
|---|---|
| No rating row for (player, format) | "No RallyCircle rating yet" (player has no finalized matches in this format). Do not show 1200. |
| `provisional: true` | Show the number with a "Provisional" badge and the confidence (e.g. "4/10 matches toward a settled rating"). Never present it as a settled number. |
| `provisional: false` | Show the number with the "RallyCircle Rating (experimental)" label. |
| Rating history | List `RatingChange` rows newest-first with the `explanation` string; reversals shown distinctly (e.g. "Reversed: …"). |
| After a match is finalized | Ratings update when the server applier runs (see integration note below); the UI should re-read the player's rating row. There is no push subscription specific to ratings in v1 — reuse the session-record subscription and re-read on finalization. |

## Possible error responses (server applier)

The applier returns `{ applied, changes, skipped, error? }`:

| `error` | Meaning |
|---|---|
| `'Current ratings could not be read.'` / `'Rating history could not be read.'` / `'Existing rating changes could not be checked.'` | Storage read failed — retry later; nothing was written for that player. |
| `'Rating change for <player> could not be saved.'` / `'Current rating for <player> could not be saved.'` | Storage write failed mid-apply — the result is partially applied; retrying the same `resultId` is safe (already-applied players are skipped). |
| Validation errors from the engine (e.g. `'A player cannot appear on both sides of a match.'`) | The result is not eligible — nothing was written. |

## Integration note (read before wiring the UI)

The engine + store applier are implemented and tested offline, but the
**trigger is not wired**: nothing in the base calls
`applyFinalizedResultToStore` automatically yet. The intended trigger is the
command room's `reviewResult` branch, right after a review makes a result
final (see `PATCHES.md`). Until that lands, ratings do not change in the
app — the UI must treat "no rating row" as the normal state, and must not
compute ratings client-side from scores.

## Known limitations (do not work around silently)

- Repeat-opponent counting reads at most the 100 most recent change
  records per player (query limit, unspecified order). For players with
  >100 rated matches in a format, K dampening may undercount. Acceptable
  in v1; revisit if any player approaches that volume.
- `finalizedResultsFromSessions` scans session records. Fine at current
  scale; Track C should index finalized results if volume grows.
- Explanations contain opaque player ids; display-name resolution is
  Track B's job.
- No decay, no time windows, no partner-synergy model, no per-set
  weighting — only the match winner matters.
- Residual collusion risk: a group could stage matches. Mitigations are
  repeat-opponent K dampening, provisional labelling, and confirmed-RSVP
  participation only. Do not claim collusion is impossible.
