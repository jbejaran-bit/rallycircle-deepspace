/**
 * Scheduling polls — validation, vote tallying and finalise guards.
 *
 * Pure logic only: no storage, no network, no clock beyond an injectable
 * `now`. The command room owns persistence and authorization; it calls
 * these helpers inside the serialised per-session queue, so two
 * simultaneous votes from one user cannot both land.
 *
 * Rules encoded here:
 * - A poll offers 2–5 distinct future times, stored as canonical ISO UTC
 *   instants. No wall-clock arithmetic happens here, so a DST transition
 *   cannot shift a proposed time: an instant is an instant.
 * - Approval-style voting: one authenticated user has at most one vote
 *   per option, and may vote for several options. Voting twice for one
 *   option is an idempotent no-op. The vote record's uniqueness is also
 *   enforced by the `pollVotes` collection (`uniqueOn:
 *   ['pollId', 'optionId', 'userId']`).
 * - Only the session host can finalise, and only to an offered option
 *   that is still in the future. Finalising never silently rewrites the
 *   session: the command room re-validates the chosen time against the
 *   live session (open status, future date) at write time and bumps
 *   `scheduleRevision`.
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

/** Parse the JSON options column of a poll record. Returns null when malformed. */
export function parsePollOptions(raw: string | undefined): PollOptionInput[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const options: PollOptionInput[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
      const { id, startsAt } = entry as Record<string, unknown>
      if (typeof id !== 'string' || typeof startsAt !== 'string') return null
      options.push({ id, startsAt })
    }
    return options
  } catch {
    return null
  }
}

export function serializePollOptions(options: PollOptionInput[]): string {
  return JSON.stringify(options.map(option => ({ id: option.id, startsAt: option.startsAt })))
}

/** Parse the JSON tally column of a poll record. Malformed input yields an empty tally. */
export function parsePollTally(raw: string | undefined): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const tally: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) tally[key] = Math.floor(value)
    }
    return tally
  } catch {
    return {}
  }
}

export function serializePollTally(tally: Record<string, number>): string {
  return JSON.stringify(tally)
}
