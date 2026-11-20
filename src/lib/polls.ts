/**
 * Scheduling polls — standalone prototype (pure logic only).
 *
 * This module is deliberately storage-agnostic: it validates and tallies
 * votes over plain data so it can be unit-tested without a live RecordRoom.
 * It is NOT yet wired to a DeepSpace collection, the command room, or any
 * UI. Wiring it in means: a `polls`/`pollVotes` collection (or options
 * embedded on the session), a command-room operation for casting a vote
 * (serialised, so two simultaneous votes from one user cannot both land),
 * and a host-only `finalize` operation that writes the chosen time back to
 * the session only after re-validating it. Do not ship the UI until that
 * wiring exists — client-side vote counting alone would be bypassable.
 *
 * Rules encoded here:
 * - A poll offers 2–5 distinct future times.
 * - One authenticated user has at most one vote per option (approval-style:
 *   voting for several options is allowed, voting twice for one is a no-op).
 * - Only the session host can finalise, and only to an offered option.
 * - Finalising never silently rewrites the session: the caller must still
 *   validate the chosen time against the session (open status, future date)
 *   at write time — that check belongs in the command room, not here.
 */

export interface PollOptionInput {
  id: string
  startsAt: string
}

export interface PollVote {
  optionId: string
  userId: string
}

export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 5

/** Validate the options a host proposes. Returns an error string or null. */
export function validatePollOptions(options: PollOptionInput[], now = Date.now()): string | null {
  if (options.length < POLL_MIN_OPTIONS) return `Propose at least ${POLL_MIN_OPTIONS} times.`
  if (options.length > POLL_MAX_OPTIONS) return `Propose at most ${POLL_MAX_OPTIONS} times.`
  const ids = new Set<string>()
  const times = new Set<number>()
  for (const option of options) {
    if (!option.id.trim() || ids.has(option.id)) return 'Each proposed time needs a unique id.'
    ids.add(option.id)
    const time = Date.parse(option.startsAt)
    if (!Number.isFinite(time) || time <= now) return 'Each proposed time must be in the future.'
    if (times.has(time)) return 'Proposed times must be different.'
    times.add(time)
  }
  return null
}

/**
 * Cast one vote. Idempotent: voting again for the same option changes
 * nothing. Returns the new vote list, or an error when the option is not
 * part of this poll (the list is returned unchanged in that case).
 */
export function castVote(
  votes: PollVote[],
  optionId: string,
  userId: string,
  optionIds: string[],
): { votes: PollVote[]; error?: string } {
  if (!optionIds.includes(optionId)) return { votes, error: 'That time is not part of this poll.' }
  if (votes.some(v => v.optionId === optionId && v.userId === userId)) return { votes }
  return { votes: [...votes, { optionId, userId }] }
}

/** Count votes per option id. Options with no votes are absent from the result. */
export function tallyVotes(votes: PollVote[]): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const vote of votes) tally[vote.optionId] = (tally[vote.optionId] ?? 0) + 1
  return tally
}

/**
 * Host-only finalise guard. Returns the chosen option id, or an error.
 * The caller must still validate the chosen time against the live session
 * before writing it (see the module header).
 */
export function finalizePoll(
  hostId: string,
  userId: string,
  optionId: string,
  optionIds: string[],
): { optionId: string } | { error: string } {
  if (hostId !== userId) return { error: 'Only the session host can finalise a poll.' }
  if (!optionIds.includes(optionId)) return { error: 'That time is not part of this poll.' }
  return { optionId }
}
