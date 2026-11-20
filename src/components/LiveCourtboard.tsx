import { useCanvas } from 'deepspace'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { APP_ID } from '@/constants'
import { type RallyRSVP } from '@/lib/rally'
import {
  clampCourtboardPosition,
  COURTBOARD_HEIGHT,
  COURTBOARD_MARKER_LABELS,
  COURTBOARD_MARKER_SIZE,
  COURTBOARD_MARKERS,
  COURTBOARD_WIDTH,
  courtboardMarkerId,
  courtboardRoomId,
  isCourtboardMarkerLabel,
  type CourtboardMarkerLabel,
  type CourtboardPosition,
} from '@/lib/courtboard'

type CanvasShape = ReturnType<typeof useCanvas>['shapes'][number]
type RallyMarkerShape = CanvasShape & {
  type: 'rally-player'
  props: CanvasShape['props'] & { label: CourtboardMarkerLabel }
}
type SessionRSVP = { data: RallyRSVP }

interface LiveCourtboardProps {
  sessionId: string
  userId: string
  hostId: string
  sessionStatus: 'open' | 'cancelled'
  rsvps: SessionRSVP[]
  rsvpStatus: 'loading' | 'ready' | 'error'
  rsvpError?: string
}

interface DragState {
  shapeId: string
  label: CourtboardMarkerLabel
  offsetX: number
  offsetY: number
  preview?: CourtboardPosition
}

const markerColors: Record<CourtboardMarkerLabel, string> = {
  A1: '#d7fc83',
  A2: '#b7eb66',
  B1: '#fda4af',
  B2: '#fb7185',
}

function isRallyMarker(shape: CanvasShape): shape is RallyMarkerShape {
  return shape.type === 'rally-player' &&
    isCourtboardMarkerLabel(shape.props.label) &&
    Number.isFinite(shape.x) &&
    Number.isFinite(shape.y)
}

function courtPoint(svg: SVGSVGElement, clientX: number, clientY: number): CourtboardPosition | null {
  const bounds = svg.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  return clampCourtboardPosition({
    x: ((clientX - bounds.left) / bounds.width) * COURTBOARD_WIDTH,
    y: ((clientY - bounds.top) / bounds.height) * COURTBOARD_HEIGHT,
  })
}

export default function LiveCourtboard({
  sessionId,
  userId,
  hostId,
  sessionStatus,
  rsvps,
  rsvpStatus,
  rsvpError,
}: LiveCourtboardProps) {
  const [retryKey, setRetryKey] = useState(0)
  const isParticipant = hostId === userId || rsvps.some(({ data }) =>
    data.sessionId === sessionId &&
    data.userId === userId &&
    (data.status === 'going' || data.status === 'maybe'),
  )

  return (
    <section
      data-testid="courtboard-panel"
      aria-labelledby="courtboard-title"
      className="rounded-2xl border border-white/10 bg-[#0e1513] p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d7fc83]">Tactics room</p>
          <h3 id="courtboard-title" className="mt-1 text-lg font-black text-white">Live Courtboard</h3>
          <p className="mt-1 text-xs text-white/55">Place your doubles team together. Changes sync to this session only.</p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-white/65">
          A side / B side
        </span>
      </header>

      {rsvpStatus === 'loading' ? (
        <p role="status" aria-busy="true" className="rounded-xl bg-white/5 p-4 text-sm text-white/65">
          Checking session access…
        </p>
      ) : rsvpStatus === 'error' ? (
        <p role="alert" className="rounded-xl border border-rose-300/25 bg-rose-400/10 p-4 text-sm text-rose-100">
          {rsvpError ?? 'Session access could not be checked. Try again.'}
        </p>
      ) : !userId ? (
        <p role="status" className="rounded-xl bg-white/5 p-4 text-sm text-white/65">Sign in to open this courtboard.</p>
      ) : !isParticipant ? (
        <p role="status" data-testid="courtboard-denied" className="rounded-xl bg-white/5 p-4 text-sm text-white/65">
          RSVP to this session to view its courtboard. Only the host and session players can open it.
        </p>
      ) : (
        <ConnectedCourtboard
          key={`${courtboardRoomId(APP_ID, sessionId)}:${sessionStatus}:${retryKey}`}
          roomId={courtboardRoomId(APP_ID, sessionId)}
          cancelled={sessionStatus === 'cancelled'}
          onRetry={() => setRetryKey((current) => current + 1)}
        />
      )}
    </section>
  )
}

function ConnectedCourtboard({
  roomId,
  cancelled,
  onRetry,
}: {
  roomId: string
  cancelled: boolean
  onRetry: () => void
}) {
  const {
    shapes,
    connected,
    canWrite,
    addShape,
    moveShape,
    deleteShape,
  } = useCanvas(roomId)
  const markers = useMemo(() => shapes.filter(isRallyMarker), [shapes])
  const markerByLabel = useMemo(() => {
    const result = new Map<CourtboardMarkerLabel, RallyMarkerShape[]>()
    for (const marker of markers) {
      const current = result.get(marker.props.label) ?? []
      current.push(marker)
      result.set(marker.props.label, current)
    }
    return result
  }, [markers])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingAdds, setPendingAdds] = useState<Set<CourtboardMarkerLabel>>(() => new Set())
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(() => new Set())
  const [movePreviews, setMovePreviews] = useState<Record<string, CourtboardPosition>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [connectionSlow, setConnectionSlow] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const drag = useRef<DragState | null>(null)
  const timers = useRef(new Map<string, number>())
  const serverPositions = useRef(new Map<string, CourtboardPosition>())
  const canEdit = connected && canWrite && !cancelled

  useEffect(() => {
    if (connected) {
      setConnectionSlow(false)
      return
    }

    const timer = window.setTimeout(() => setConnectionSlow(true), 8000)
    return () => window.clearTimeout(timer)
  }, [connected, roomId])

  useEffect(() => {
    const presentIds = new Set(markers.map((marker) => marker.id))
    const changedIds = new Set<string>()
    const nextPositions = new Map<string, CourtboardPosition>()
    for (const marker of markers) {
      const position = { x: marker.x, y: marker.y }
      const previous = serverPositions.current.get(marker.id)
      if (previous && (previous.x !== position.x || previous.y !== position.y)) {
        changedIds.add(marker.id)
      }
      nextPositions.set(marker.id, position)
    }

    for (const [id, preview] of Object.entries(movePreviews)) {
      const serverShape = markers.find((marker) => marker.id === id)
      if (!serverShape || changedIds.has(id)) {
        if (serverShape?.x === preview.x && serverShape.y === preview.y) {
          setAnnouncement(`${serverShape.props.label} position was confirmed by the shared board.`)
        } else if (serverShape) {
          setAnnouncement(`Another player updated ${serverShape.props.label}; their server position is now shown.`)
        }
        setMovePreviews((current) => {
          if (!current[id]) return current
          const next = { ...current }
          delete next[id]
          return next
        })
      }
    }
    serverPositions.current = nextPositions

    for (const label of pendingAdds) {
      if (markerByLabel.has(label)) {
        clearPending(`add:${label}`)
        setPendingAdds((current) => without(current, label))
        setAnnouncement(`${label} marker was added to the shared board.`)
      }
    }
    for (const id of pendingDeletes) {
      if (!presentIds.has(id)) {
        clearPending(`delete:${id}`)
        setPendingDeletes((current) => without(current, id))
        setAnnouncement('Marker removal was confirmed by the shared board.')
      }
    }
  }, [markers, markerByLabel, movePreviews, pendingAdds, pendingDeletes])

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
  }, [])

  function clearPending(key: string) {
    const timer = timers.current.get(key)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(key)
  }

  function confirmAfterTimeout(
    key: string,
    message: string,
    clear: () => void,
  ) {
    clearPending(key)
    timers.current.set(key, window.setTimeout(() => {
      timers.current.delete(key)
      clear()
      setActionError(message)
    }, 8000))
  }

  function addMarker(label: CourtboardMarkerLabel) {
    if (!canEdit || markerByLabel.has(label) || pendingAdds.has(label)) return
    setActionError(null)
    setPendingAdds((current) => new Set(current).add(label))
    confirmAfterTimeout(
      `add:${label}`,
      `${label} was not confirmed by the server. Check the board before trying again.`,
      () => setPendingAdds((current) => without(current, label)),
    )
    addShape({
      id: courtboardMarkerId(label),
      type: 'rally-player',
      ...COURTBOARD_MARKERS[label],
      width: COURTBOARD_MARKER_SIZE,
      height: COURTBOARD_MARKER_SIZE,
      props: { label },
    })
  }

  function removeMarker(marker: RallyMarkerShape) {
    if (!canEdit || pendingDeletes.has(marker.id)) return
    setActionError(null)
    setPendingDeletes((current) => new Set(current).add(marker.id))
    confirmAfterTimeout(
      `delete:${marker.id}`,
      `${marker.props.label} removal was not confirmed. Check the board before retrying.`,
      () => setPendingDeletes((current) => without(current, marker.id)),
    )
    deleteShape(marker.id)
  }

  function beginDrag(event: PointerEvent<SVGGElement>, marker: RallyMarkerShape) {
    if (!canEdit) return
    const svg = event.currentTarget.ownerSVGElement
    if (!svg) return
    const point = courtPoint(svg, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(marker.id)
    const preview = movePreviews[marker.id]
    const x = preview?.x ?? marker.x
    const y = preview?.y ?? marker.y
    drag.current = {
      shapeId: marker.id,
      label: marker.props.label,
      offsetX: point.x - x,
      offsetY: point.y - y,
      preview: { x, y },
    }
    setActiveDragId(marker.id)
    if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    const current = drag.current
    if (!current || !canEdit) return
    const point = courtPoint(event.currentTarget, event.clientX, event.clientY)
    if (!point) return
    const preview = clampCourtboardPosition({
      x: point.x - current.offsetX,
      y: point.y - current.offsetY,
    })
    if (!preview) return
    current.preview = preview
    setMovePreviews((existing) => ({
      ...existing,
      [current.shapeId]: preview,
    }))
  }

  function finishDrag() {
    const current = drag.current
    drag.current = null
    setActiveDragId(null)
    if (!current || !current.preview || !canEdit) return
    moveShape(current.shapeId, current.preview.x, current.preview.y)
    setAnnouncement(`${current.label} moved locally. The saved position is confirmed by another player or when the board reconnects.`)
  }

  function nudgeMarker(marker: RallyMarkerShape, dx: number, dy: number) {
    if (!canEdit) return
    const preview = clampCourtboardPosition({ x: marker.x + dx, y: marker.y + dy })
    if (!preview) return
    setSelectedId(marker.id)
    setMovePreviews((current) => ({
      ...current,
      [marker.id]: preview,
    }))
    moveShape(marker.id, preview.x, preview.y)
    setAnnouncement(`${marker.props.label} moved locally. The saved position is confirmed by another player or when the board reconnects.`)
  }

  const selectedMarker = markers.find((marker) => marker.id === selectedId)
  const pendingMoveCount = Object.keys(movePreviews).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          data-testid="courtboard-status"
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-xs font-semibold text-white/65"
        >
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-[#d7fc83]' : 'bg-amber-300'}`} />
          {connected
            ? canWrite
              ? `Connected · editing enabled${pendingMoveCount ? ` · ${pendingMoveCount} local preview${pendingMoveCount === 1 ? '' : 's'}` : ''}`
              : 'Connected · read-only'
            : connectionSlow
              ? 'Disconnected · trying to reconnect'
              : 'Connecting to the shared court…'}
        </p>
        {!connected && (
          <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-[#d7fc83] hover:bg-white/5">
            <RefreshCw size={13} /> Retry
          </button>
        )}
      </div>

      {connected && !canWrite && (
        <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/60">
          This board is read-only. Cancelled sessions keep their saved plan available to participants.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Add player markers">
          {COURTBOARD_MARKER_LABELS.map((label) => {
            const exists = markerByLabel.has(label)
            const pending = pendingAdds.has(label)
            return (
              <button
                key={label}
                type="button"
                data-testid={`courtboard-add-${label}`}
                disabled={!canEdit || exists || pending}
                onClick={() => addMarker(label)}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white transition hover:border-[#d7fc83]/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
                {exists ? `${label} on court` : pending ? `Adding ${label}…` : `Add ${label}`}
              </button>
            )
          })}
        </div>
        {selectedMarker && (
          <button
            type="button"
            data-testid="courtboard-remove-selected"
            disabled={!canEdit || pendingDeletes.has(selectedMarker.id)}
            onClick={() => removeMarker(selectedMarker)}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300/20 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 size={14} />
            {pendingDeletes.has(selectedMarker.id) ? 'Removing…' : `Remove ${selectedMarker.props.label}`}
          </button>
        )}
      </div>

      {actionError && <p role="alert" className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{actionError}</p>}

      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a5b38]">
        <svg
          data-testid="courtboard-court"
          viewBox={`0 0 ${COURTBOARD_WIDTH} ${COURTBOARD_HEIGHT}`}
          role="group"
          aria-label="Top-down tennis court. Drag a marker to move it. Focus a marker and use arrow keys or the move buttons."
          className="block h-auto w-full touch-none select-none"
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <defs>
            <linearGradient id="court-grass" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#267447" />
              <stop offset="1" stopColor="#1c603a" />
            </linearGradient>
            <filter id="marker-shadow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#07110b" floodOpacity=".42" />
            </filter>
          </defs>
          <rect width="1000" height="500" fill="url(#court-grass)" />
          <rect x="36" y="24" width="928" height="452" rx="18" fill="#28794a" stroke="#baf58a" strokeOpacity=".24" strokeWidth="2" />
          <rect x="92" y="54" width="816" height="392" fill="#247348" stroke="#f4f8e9" strokeWidth="4" />
          <line x1="160" y1="54" x2="160" y2="446" stroke="#f4f8e9" strokeWidth="3" />
          <line x1="840" y1="54" x2="840" y2="446" stroke="#f4f8e9" strokeWidth="3" />
          <line x1="160" y1="160" x2="840" y2="160" stroke="#f4f8e9" strokeWidth="3" />
          <line x1="160" y1="340" x2="840" y2="340" stroke="#f4f8e9" strokeWidth="3" />
          <line x1="500" y1="160" x2="500" y2="340" stroke="#f4f8e9" strokeWidth="3" />
          <line x1="36" y1="250" x2="964" y2="250" stroke="#f4f8e9" strokeOpacity=".85" strokeWidth="3" />
          <line x1="42" y1="250" x2="958" y2="250" stroke="#142c20" strokeOpacity=".58" strokeDasharray="5 7" strokeWidth="1" />
          <text x="54" y="48" fill="#e9f7d8" fontSize="16" fontWeight="700" letterSpacing="2">DOUBLES</text>

          {markers.map((marker) => {
            const preview = movePreviews[marker.id]
            const x = preview?.x ?? marker.x
            const y = preview?.y ?? marker.y
            const label = marker.props.label
            const isSelected = selectedId === marker.id
            const isDragging = activeDragId === marker.id
            const color = markerColors[label]
            return (
              <g
                key={marker.id}
                data-testid={`courtboard-marker-${label}`}
                data-marker-id={marker.id}
                data-x={x}
                data-y={y}
                role="button"
                tabIndex={0}
                aria-label={`${label} player marker at ${Math.round(x)}, ${Math.round(y)}. ${canEdit ? 'Drag or use arrow keys to move.' : 'Read-only.'}`}
                aria-pressed={isSelected}
                className={canEdit ? 'cursor-grab focus:outline-none active:cursor-grabbing' : 'cursor-default focus:outline-none'}
                onClick={() => setSelectedId(marker.id)}
                onPointerDown={(event) => beginDrag(event, marker)}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 30 : 12
                  const deltas: Partial<Record<string, [number, number]>> = {
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step],
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                  }
                  const delta = deltas[event.key]
                  if (delta && canEdit) {
                    event.preventDefault()
                    nudgeMarker(marker, delta[0], delta[1])
                  } else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedId(marker.id)
                  }
                }}
                filter="url(#marker-shadow)"
              >
                <circle cx={x} cy={y} r="56" fill="#ffffff" fillOpacity=".01" />
                <circle
                  cx={x}
                  cy={y}
                  r={COURTBOARD_MARKER_SIZE / 2}
                  fill={color}
                  fillOpacity={isDragging ? '.78' : '1'}
                  stroke={isSelected ? '#ffffff' : '#17301e'}
                  strokeWidth={isSelected ? '5' : '3'}
                />
                <text
                  x={x}
                  y={y + 6}
                  textAnchor="middle"
                  fill="#122019"
                  fontSize="32"
                  fontWeight="900"
                  pointerEvents="none"
                >
                  {label}
                </text>
              </g>
            )
          })}
          {markers.length === 0 && (
            <text x="500" y="250" textAnchor="middle" fill="#edf6e3" fontSize="22" fontWeight="700" opacity=".8">
              Add a player marker to start
            </text>
          )}
        </svg>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-white/45">
          {pendingMoveCount
            ? 'A local move preview is shown. Other players’ updates and a reconnected room snapshot are server-confirmed.'
            : 'Server-synchronized plan · drag markers or focus one and use arrow keys.'}
        </p>
        <div role="group" aria-label="Move selected marker" className="flex items-center gap-1">
          <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-white/40">Move</span>
          <NudgeButton label="Move selected marker up" disabled={!selectedMarker || !canEdit} onClick={() => selectedMarker && nudgeMarker(selectedMarker, 0, -12)}><ArrowUp size={14} /></NudgeButton>
          <NudgeButton label="Move selected marker left" disabled={!selectedMarker || !canEdit} onClick={() => selectedMarker && nudgeMarker(selectedMarker, -12, 0)}><ArrowLeft size={14} /></NudgeButton>
          <NudgeButton label="Move selected marker down" disabled={!selectedMarker || !canEdit} onClick={() => selectedMarker && nudgeMarker(selectedMarker, 0, 12)}><ArrowDown size={14} /></NudgeButton>
          <NudgeButton label="Move selected marker right" disabled={!selectedMarker || !canEdit} onClick={() => selectedMarker && nudgeMarker(selectedMarker, 12, 0)}><ArrowRight size={14} /></NudgeButton>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  )
}

function NudgeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-white/75 hover:border-[#d7fc83]/50 hover:text-[#d7fc83] disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  )
}

function without<T>(current: Set<T>, value: T): Set<T> {
  const next = new Set(current)
  next.delete(value)
  return next
}
