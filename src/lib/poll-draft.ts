import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, validatePollOptions, type PollOptionInput } from './polls'
import { parseLocalSessionStart } from './rally'

export function buildPollDraft(values: readonly string[], now = Date.now()):
  { options: PollOptionInput[] } | { error: string } {
  if (values.length < POLL_MIN_OPTIONS || values.length > POLL_MAX_OPTIONS) {
    return { error: `Propose ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} times.` }
  }
  const options: PollOptionInput[] = []
  for (const [index, value] of values.entries()) {
    const time = parseLocalSessionStart(value)
    if (!time) return { error: `Choose a valid date and time for option ${index + 1}.` }
    options.push({ id: `option-${index + 1}`, startsAt: time.toISOString() })
  }
  const error = validatePollOptions(options, now)
  return error ? { error } : { options }
}
