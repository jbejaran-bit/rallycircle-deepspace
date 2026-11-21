import type { ActionHandler } from 'deepspace/worker'
import { z } from 'zod'
import type { Env } from '../../worker.js'
import { SESSION_FORMATS, validateSession } from '../lib/rally.js'

const rallyDraft = z.object({
  format: z.enum(SESSION_FORMATS).optional(),
  title: z.string().trim().max(72),
  court: z.string().trim().max(100),
  location: z.string().trim().max(100),
  startsAt: z.iso.datetime(),
  durationMinutes: z.number(),
  targetPlayers: z.number(),
  capacity: z.number().optional(),
  level: z.enum(['All levels', 'Beginner', 'Intermediate', 'Advanced']),
  notes: z.string().trim().max(400),
}).strict()

export const createRallyAction: ActionHandler<Env> = async ({ params, tools }) => {
  const parsed = rallyDraft.safeParse(params)
  if (!parsed.success) return { success: false, error: 'Check the rally details and try again.' }
  const problem = validateSession(parsed.data)
  if (problem) return { success: false, error: problem }
  const created = await tools.create('sessions', {
    ...parsed.data,
    startsAt: new Date(parsed.data.startsAt).toISOString(),
    status: 'open',
    chatChannelId: '',
  })
  if (!created.success) return { success: false, error: 'The rally could not be created. Try again.' }
  return { success: true, data: { recordId: created.data.recordId } }
}
