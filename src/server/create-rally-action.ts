import type { ActionHandler } from 'deepspace/worker'
import { z } from 'zod'
import type { Env } from '../../worker.js'
import { SESSION_FORMATS, validateSession } from '../lib/rally.js'
import { MAX_COURT_PLACE_LENGTH, normalizeCourtPlace } from '../lib/rally-place.js'

const rallyDraft = z.object({
  format: z.enum(SESSION_FORMATS).optional(),
  title: z.string().trim().max(72),
  court: z.string().trim().max(100),
  location: z.string().trim().max(100),
  courtPlace: z.string().max(MAX_COURT_PLACE_LENGTH).optional(),
  startsAt: z.iso.datetime(),
  durationMinutes: z.number(),
  targetPlayers: z.number(),
  capacity: z.number().optional(),
  level: z.enum(['All levels', 'Beginner', 'Intermediate', 'Advanced']),
  notes: z.string().trim().max(400).optional(),
}).strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const createRallyAction: ActionHandler<Env> = async ({ userId, params, env }) => {
  const parsed = rallyDraft.safeParse(params)
  if (!parsed.success) return { success: false, error: 'Check the rally details and try again.' }
  // Drafts from before the notes column carry no notes; store '' so the
  // created record is complete and validateSession never sees undefined.
  const draft = { ...parsed.data, notes: parsed.data.notes ?? '' }
  const problem = validateSession(draft)
  if (problem) return { success: false, error: problem }
  if (draft.courtPlace !== undefined) draft.courtPlace = normalizeCourtPlace(draft.courtPlace)!
  // Creation is serialized per host in a dedicated command room
  // (`rally:<appId>:user:<userId>`): the room returns the existing open
  // session when the draft exactly matches one, so a double-submit or a
  // retry after a transient failure lands on one session instead of two.
  // The marker header keeps this working with the room's internal-action
  // check (K01 fix). Without the room binding the action fails closed
  // rather than creating directly and re-introducing the race.
  const rooms = env.RALLY_COMMAND_ROOMS
  if (!rooms) return { success: false, error: 'The rally could not be created. Try again.' }
  const room = rooms.get(rooms.idFromName(`rally:${env.DEEPSPACE_APP_ID}:user:${userId}`))
  let result: unknown
  try {
    const response = await room.fetch(
      new Request('https://internal/rally-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true' },
        body: JSON.stringify({
          operation: 'createRally',
          userId,
          draft: { ...draft, startsAt: new Date(parsed.data.startsAt).toISOString() },
        }),
      }),
    )
    if (!response.ok) return { success: false, error: 'The rally could not be created. Try again.' }
    result = await response.json()
  } catch {
    return { success: false, error: 'The rally could not be created. Try again.' }
  }
  if (isRecord(result) && result.success === true && isRecord(result.data) &&
      typeof result.data.recordId === 'string') {
    return { success: true, data: { recordId: result.data.recordId } }
  }
  if (isRecord(result) && result.success === false && typeof result.error === 'string') {
    return { success: false, error: result.error }
  }
  return { success: false, error: 'The rally could not be created. Try again.' }
}
