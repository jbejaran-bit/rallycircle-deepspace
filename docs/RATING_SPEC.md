# RallyCircle Rating — specification (experimental)

**Status: experimental.** This is RallyCircle's own community rating. It is
**not** a UTR score, it is **not** equivalent to NTRP, UTR, or any proprietary
ranking, and it is **not** scientifically validated. Any UI that shows it
must label it "RallyCircle Rating (experimental)" and must show the
provisional state for new players. Do not use it to claim a player has an
official skill level.

**Algorithm version: 1** (`RATING_ALGORITHM_VERSION = 1`). Every stored
rating record carries its algorithm version. A future algorithm change must
not silently rewrite history; recomputation, if ever needed, is a separate
explicit migration that writes new versioned records.

## 1. Model

A simple, deterministic Elo-style update, applied per format. The formula is
deliberately boring so any player can check it by hand.

- **Scale.** Every player starts at **1200** in each format
  (`RATING_START`). Ratings are integers, clamped to **[100, 3000]**
  (`RATING_MIN`, `RATING_MAX`) so a runaway or corrupt input cannot produce
  an absurd number.
- **Expected score.** For player A rated `Ra` against opponent/team rated
  `Rb`, A's expected score is

  `E = 1 / (1 + 10^((Rb − Ra) / 400))`

  Equal ratings give E = 0.5. A 400-point gap gives the stronger side
  E ≈ 0.91 and the weaker side E ≈ 0.09.
- **Update.** After a match with outcome `S` (1 for a win, 0 for a loss),

  `R' = R + K × (S − E)`

  The delta is rounded to the nearest integer (`Math.round`). In a singles
  match the two deltas are exact negatives before rounding, so the match is
  zero-sum; in doubles the four deltas need not sum to exactly zero (each
  player has their own K and expected score), and a ±1 drift is accepted and
  documented.
- **K-factor schedule** (`kFactor`, by finalized matches already played in
  that format, counted *before* this match):

  | Finalized matches played | K |
  |---|---|
  | 0–9 | 40 |
  | 10–29 | 32 |
  | 30+ | 24 |

  New players move fast (their rating is mostly unknown); established
  players move slowly (their rating is mostly known). This is the whole
  reason for the schedule, and it is the only "learning rate" in the system.
- **Repeat-opponent dampening.** After a player has **3 or more prior
  finalized matches against the same opponent** (singles: that exact
  opponent; doubles: any match in which the player faced at least one member
  of the opposing team), K is **halved** for later matches against that
  opponent (20 / 16 / 12). Purpose: make farming one weak opponent, or
  staging repeated matches against the same partner group, worth
  progressively less. The count is over the player's whole finalized
  history in v1 (no time window — match volume is low, and a window would
  add complexity without evidence it is needed). A window is a possible v2
  refinement.
- **No decay in v1.** Inactivity never changes a rating. A player who stops
  playing keeps their last rating (and their provisional flag, if they had
  one). If decay is ever wanted, it must be an explicit, announced policy
  with its own algorithm version — never a silent background change.

## 2. Eligibility (D02)

A result affects ratings **only if** it is finalized under the base result
workflow (`resultStatus(score) === 'final'` in `src/lib/rally-score.ts`):
a winner exists, the result is not disputed, and **every recorded
participant has approved**. Proposed, partially confirmed, disputed, or
in-progress results are ignored. The engine additionally validates:

- the format is `Singles` or `Doubles` (Practice has no match and is
  rejected);
- team sizes match the format (1v1 singles, 2v2 doubles);
- all player ids are non-empty strings, distinct within a team, and no
  player appears on both sides (self-play is impossible — and the base
  `startMatch` already enforces distinct players with confirmed RSVPs);
- the winner is side 0 or 1.

Anything failing validation is rejected with a named error and affects no
rating. Only finalized results from real sessions with recorded participants
count. Residual collusion risk is real and stated honestly: a group of
accounts could stage matches against each other. Mitigations in v1 are the
repeat-opponent dampening above, the provisional flag (staged results from
new accounts stay provisional), and the fact that only confirmed RSVPs can
be recorded as match participants. Those mitigate; they do not eliminate.
Do not claim otherwise.

## 3. Singles vs doubles (D04)

**Separate ratings per format.** A player's singles rating and doubles
rating are independent numbers with independent match counts and
provisional flags. Rationale: doubles skill (positioning, partner play,
covering) is not the same as singles skill, and mixing the two would let a
strong doubles player look like a strong singles player (or vice versa).
Tradeoff: each format needs its own 10 matches to leave provisional, so a
player who only plays doubles stays provisional in singles indefinitely.
That is honest — it means "we have no singles evidence for this player" —
and is preferable to a blended number that misleads in both formats.

**Doubles update rule.** A team's rating is the **mean of its partners'
ratings**. Each player is updated against the **opposing team's mean
rating**, using their own K and their own expected score
(`E_i = E(rating_i, oppTeamMean)`), with the shared outcome S (1 for the
winning team, 0 for the losing team). Consequence: in an upset win, the
lower-rated partner gains more than the higher-rated partner, which matches
the intuition that the upset says more about the lower-rated player. Partner
synergy is not modelled — the mean is a simplification, documented here
rather than hidden.

## 4. Provisional state (D03, D11)

A player is **provisional** in a format while they have fewer than **10
finalized matches** in that format (`PROVISIONAL_MATCH_THRESHOLD = 10`).
Provisional ratings are shown with the provisional flag and a confidence
indicator equal to `matchesPlayed / 10` (e.g. 4 matches → 40% confidence).
The number itself is still the engine's best estimate; the flag is the
honest statement that the estimate is based on little evidence. Never show a
provisional rating as a settled number. After the 10th finalized match the
flag clears. There is no fake precision anywhere: ratings are integers, and
the confidence indicator is a match count, not a statistical interval.

## 5. Worked example

Ana and Bea have never played a finalized match (both 1200, K = 40,
provisional 0/10).

**Match 1 — singles, Ana beats Bea.**
E = 0.5 each. Ana: `1200 + 40 × (1 − 0.5) = +20 → 1220`. Bea:
`1200 + 40 × (0 − 0.5) = −20 → 1180`. Both now 1 match played, still
provisional.

**Match 2 — singles, Ana (1220) beats Cara (1400).**
Ana's expected score: `E = 1 / (1 + 10^((1400 − 1220)/400)) = 1 / (1 +
10^0.45) ≈ 1 / 3.818 ≈ 0.262` (about a 26% win chance — an upset).
Ana: `1220 + 40 × (1 − 0.262) = 1220 + 29.5 → 1250` (rounded).
Cara: `1400 + 40 × (0 − 0.738) = 1400 − 29.5 → 1370` (rounded).
Explanation shown to Ana: "Beat Cara (1400) in singles · you were expected
to win 26% of the time · +30".

**Match 3 — doubles, Ana (1250) + Dan (1200) beat Bea (1180) + Cara (1370).**
Team means: Ana/Dan 1225, Bea/Cara 1275. Ana's expected score vs 1275:
`E = 1 / (1 + 10^((1275 − 1250)/400)) ≈ 0.464`. Ana (K still 40, 2 matches
played): `1250 + 40 × (1 − 0.464) ≈ +21 → 1271` (doubles). Her singles
rating is untouched at 1250.

## 6. History, versioning, corrections (D06–D09)

- **Append-only history.** Every rating change is a record in the
  `ratingChanges` collection: `resultId`, `playerId`, `format`,
  `algorithmVersion`, `before`, `after`, `delta`, `reason`
  (`'result' | 'reversal' | 'correction'`), `explanation`,
  `opponentIds` (used for repeat-opponent counting). Records are never
  edited or deleted by the engine.
- **Current rating.** The `playerRatings` collection holds one record per
  (player, format): current `rating`, `matchesPlayed`, `provisional`,
  `algorithmVersion`, `lastResultId`, and `status: 'experimental'`. It is a
  cache of the latest history entry, not the source of truth; the history
  can always reproduce it.
- **Idempotency (D09).** `resultId` is `session:<sessionId>:rev:<revision>`
  — the session plus the match-score revision at finalization. The store
  applier checks for an existing `ratingChanges` record for
  (`resultId`, `playerId`) before writing; applying the same result twice
  is a no-op for that player. `uniqueOn: ['resultId', 'playerId']` enforces
  this at the schema level too.
- **Corrections and disputes (D08).** If a finalized result is later
  corrected or invalidated, the engine **reverses** its effect: it appends a
  `reason: 'reversal'` change record carrying the **negated delta applied
  to the player's current rating** (not a restore of the old rating — the
  player may have played more matches since, and restoring would erase
  those) and decrements matches played by one. History is never edited. If the corrected
  result is itself finalized again (new revision → new `resultId`), it is
  applied as a fresh result. Note: the base has **no correction workflow
  yet** — the reversal API is defined here so Track C can call it when a
  correction/invalidation transition lands. Reversing an already-reversed
  result is a no-op.
- **Versioning (D07).** Every record carries `algorithmVersion: 1`. A v2
  algorithm must write v2 records and must not rewrite v1 history. If a
  full recomputation is ever required, it is a separate explicit migration
  that writes new records; the old records stay.

## 7. Transparency (D12–D13)

Every change record carries a human-readable `explanation`, e.g.
"Beat Cara (1400) in singles · expected win chance 26% · K 40 · +30" or
"Lost to Dan (1180) and Bea (1210) in doubles (team 1195) · expected win
chance 54% · K 32 · −15". The frontend contract (`docs/track-d-contracts.md`)
exposes the explanation, the before/after ratings, the K used, the expected
score, and the provisional state, so Codex can show *why* a rating moved
without inventing a reason. The rating is always labelled experimental and
is never presented as scientifically validated or as an official skill level.

## 8. What this system deliberately does not do

- No decay, no time windows, no partner-synergy model, no per-point or
  per-set weighting (a 6–0 win counts the same as a 7–6 win — only the
  winner matters, because the base result records sets but the rating
  consumes only the outcome).
- No cross-format blending.
- No rating changes from anything but finalized results. RSVPs, waitlists,
  court visits, and practice sessions never affect ratings.
- No writes into any release-candidate statistics path. No such path exists
  in the base, and this package does not create one — ratings live in their
  own collections, marked experimental, on a separate feature branch.
