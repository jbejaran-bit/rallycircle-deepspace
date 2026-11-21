import { useState } from 'react'
import { getResultAudit, type ResultAuditEntry } from '@/lib/profile-actions'

const eventLabels = {
  finalized: 'Result confirmed',
  disputed: 'Result disputed',
  corrected: 'Score corrected',
}

export default function ResultAudit({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<ResultAuditEntry[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setBusy(true)
    setError('')
    try {
      const response = await getResultAudit(sessionId)
      if (!Array.isArray(response.data?.entries)) throw new Error('Result activity could not be loaded.')
      setEntries(response.data.entries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Result activity could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="space-y-2 rounded-lg border border-white/25 p-3" onToggle={event => {
      if (event.currentTarget.open && !entries && !busy) void load()
    }}>
      <summary className="cursor-pointer py-2 font-semibold">Result activity</summary>
      {busy && <p role="status">Loading activity…</p>}
      {error && <p role="alert" className="text-rose-200">{error}</p>}
      {entries?.length === 0 && <p className="text-sm text-white/75">No activity has been recorded for this result.</p>}
      {entries && entries.length > 0 && (
        <ul className="space-y-1 text-sm">
          {entries.map((entry, index) => (
            <li key={`${entry.kind}-${entry.resultRevision}-${index}`}>
              {eventLabels[entry.kind]} <span className="text-white/65">({entry.resultRevision})</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
