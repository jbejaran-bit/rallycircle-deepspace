import { useMemo } from 'react'
import { ExternalLink, Navigation } from 'lucide-react'
import CourtDiscoveryMap from './CourtDiscoveryMap'
import { googleMapsDirectionsUrl, parseRallyPlace } from '@/lib/rally-place'

const keepSelection = () => undefined

export default function RallyPlacePreview({ courtPlace }: { courtPlace?: string | null }) {
  const place = useMemo(() => parseRallyPlace(courtPlace), [courtPlace])
  const points = useMemo(() => place ? [place] : [], [place])
  if (!place) return null
  return <section className="space-y-3 rounded-2xl border border-white/10 bg-[#101714] p-4 sm:p-5" aria-label="Rally court location">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="text-base font-semibold">Court location</h3><p className="mt-1 break-words text-sm text-white/75">{place.address}</p></div>
      <a className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/25 px-3 py-2 text-sm font-semibold hover:bg-white/5" href={googleMapsDirectionsUrl(place) ?? undefined} target="_blank" rel="noopener noreferrer"><Navigation size={16} aria-hidden />Get directions<ExternalLink size={13} aria-hidden /></a>
    </div>
    <CourtDiscoveryMap courts={points} label={`Map of ${place.name}`} selectedId={place.id} onSelect={keepSelection} compact />
    <p className="text-xs tabular-nums text-white/65">Selected pin: {place.lat.toFixed(6)}, {place.lng.toFixed(6)}</p>
  </section>
}
