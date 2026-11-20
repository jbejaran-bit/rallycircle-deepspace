# Design — Nearby Courts + Find Games

## What already existed at `8fd8c2c`

- `src/lib/courts.ts`: three hard-coded Pittsburgh courts (Schenley,
  Highland, Frick) with RecDesk booking links, plus `findCourt` and a
  haversine `distanceMiles`.
- `src/pages/(app)/(protected)/courts.tsx`: a Pittsburgh-only page —
  Leaflet map, one-shot geolocation sort, selected-court panel, "Plan a
  Rally here" via `/rallies?court=<id>`.
- `src/schemas/rally-schema.ts`: sessions have text-only `court` /
  `location`, `level` select, `status` open/cancelled; members can read
  all sessions; RSVP is server-enforced by the RallyCommandRoom DO.
- `src/lib/rally.ts`: `validateSession`, `summarizeAttendance`,
  `summarizeReadiness`, `formatSessionTime`, `buildSessionUrl`.
- `leaflet@^1.9.4` + `@types/leaflet` already in `package.json`; no new
  dependencies were added.
- **No capacity mode exists in this base.** `targetPlayers` is a planning
  goal, not a cap (the create form says so explicitly). Nothing in this
  draft depends on unmerged capacity work.

## Architecture

```
Browser ──GET /api/courts/nearby?lat&lng&radiusKm──▶ Worker (Hono)
  │  (Bearer JWT via getAuthToken, same as rally actions)      │
  │  401 without auth · 400 bad coords · 502 upstream failure │
  │  in-memory TTL cache (10 min, 50 entries, ~100 m rounding)│
  └──────────────▶ Overpass API (POST, tight around: query) ──▶ OSM data
Browser ──GET /api/geocode?q=──────▶ Worker ──paced ≥1.1 s──▶ Nominatim
Browser ──useQuery('sessions'/'rsvps')──▶ RecordRoom (existing live sync)
```

### Why server-side for OSM

1. **Usage policy.** The public Overpass instance asks for <10,000
   queries/day and <1 GB/day for one-off use, and divides that by 100 for
   regularly-used apps; Nominatim caps at 1 req/s for the whole
   application. Direct client calls would multiply traffic by the user
   count and risk per-IP blocks for everyone.
2. **Privacy.** The viewer's coordinates go to RallyCircle's own worker
   only. Overpass receives coordinates as part of a radius query (that is
   the query) with no user identity. Coordinates are never stored,
   logged, or written to a record.
3. **Resilience.** Upstream failures become a clean JSON 502 and the
   Pittsburgh fallback; the client never sees an upstream HTML error page.

### Why no new collection / schema change

Sessions stay text-location only. Adding `lat`/`lng` columns would be a
migration with compatibility questions (old sessions, Copilot's in-flight
work) and is not needed: distance filtering works from the *known-court*
lists (3 Pittsburgh courts + courts discovered this tab), and text-only
sessions simply have no distance. If coordinates-per-session is wanted
later, it is a small additive schema change — the filter code already
accepts a `knownCourts` list.

### Find Games: small-scale filtered view, deliberately

The task allows this: "implement a reliable small-scale filtered
experience using the existing live records before considering dedicated
geographic indexing." Session volume is tens, not thousands; `useQuery`
already syncs all sessions to every signed-in member, so client-side
filtering costs nothing extra and inherits the existing auth/RSVP rules
for free. The filter inputs (area/level/format/date/distance) map 1:1
onto a future server query if volume ever demands it.

## Decisions and trade-offs

| Decision | Why | Cost / limitation |
|---|---|---|
| Overpass `nwr["leisure"="pitch"]["sport"~"tennis"]` | The standard tagging for tennis courts; covers nodes/ways/relations, multi-sport pitches | Misses courts tagged only `sport=tennis` without `leisure=pitch`, and courts mapped as `leisure=sports_centre` without pitches. Documented; query can be widened later if coverage proves thin. |
| Radius 5/10/25/50 km, default 10 km | Matches Overpass `around:` (metres) and typical city search | Users in sparse areas must pick 25/50 km manually. |
| Games distance default 10 miles | US audience; miles in the existing UI | Courts radius is km (Overpass), games radius is miles (UI) — converted at the boundary, documented. |
| Attributes shown only when tagged | OSM coverage is uneven; inventing "clay" or "lit" would be false | Many courts show "No surface/lighting details listed" — honest but sparse. |
| No availability / booking claims | No legitimate live source; RecDesk links remain only for the 3 Pittsburgh courts | Users must check availability themselves; the UI says so. |
| Nominatim search on submit only, paced ≥1.1 s | Usage policy forbids autocomplete and caps at 1 req/s app-wide | Slightly slower place search; acceptable for a one-off search. |
| No geocoding of session locations | Would fabricate coordinates and spend Nominatim quota per session | Distance filter only applies to sessions at known courts; the UI explains this and keeps text-only sessions visible when no distance filter is set. |
| Discovered courts shared to Find Games via `sessionStorage` | Ephemeral, per-tab, never a record; avoids a new collection | Distances for OSM courts only work if the user visited the Courts page first this tab. Pittsburgh courts always work. |
| Map remounts on new results (`key`) | Avoids Leaflet layer bookkeeping bugs | Slightly heavier than updating markers; fine at this scale. |
| Overpass 429/503 → 502, no retry | Policy says pause 30 s; server-side retry would hammer a loaded service | User must tap again; the error message says to wait. |

## Security / privacy checklist

- Both new API routes require a verified JWT (401 otherwise), reusing
  `resolveAuth` — same boundary as the rally command action.
- No user identity is forwarded to Overpass/Nominatim; requests carry an
  identifying `User-Agent` + `Referer` per policy, nothing else.
- Coordinates are validated server-side (lat ±90, lng ±180, finite;
  radius clamped 1–50 km) and never interpolated into anything but the
  Overpass query body (parameterised via `URLSearchParams`).
- Geocode query length 2–200 chars; no free-form upstream URL.
- Geolocation is one-shot, user-initiated, never watched, never stored.
  No participant location is ever used; no home location is exposed.
- `q` and coordinates are not logged.
- Sessions listed in Find Games are exactly the sessions the signed-in
  member can already read; cancelled/past are excluded by default and
  labelled when shown. There are no private sessions in this schema, so
  there is nothing extra to hide — and nothing new is exposed.

## What was NOT done (and why)

- No live two-account browser test — needs `deepspace test run` + test
  accounts, unavailable here. Playwright spec is written with route
  interception but **not run**; labelled as such.
- No screenshots — no dev server could be started (see log).
- No push / draft PR / bundle — no worktree exists to push from.
- No capacity/"full" state in Find Games — capacity mode does not exist
  in the base; inventing it would misrepresent the product.
- No point-by-point scoring, calendar, or video work — out of scope for
  this task.
