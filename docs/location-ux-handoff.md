# Court locations and map UX follow-up

Branch: `feature/court-location-map-ux-20261122`. Base: PR #29 at `20f8fd10998f08138c2eba199a7b699845230a98`. Development is isolated in `C:/dev/rallycircle-location-ux`; the approved deployment checkout remains clean at `5bd06f978753ef946aa4e31f7d037dab7f64f15d`. No merge, deployment, activation retry, production write, paid API invocation or internship submission was performed.

## Result

- Session details expose **Add to Google Calendar** without a visible `.ics` download. The populated editor flow, UTC/time-zone handling and confirmation rules remain intact. Direct save remains source-disabled; retained iCalendar utilities still have regression coverage.
- Creation and editing share a submitted court/place search, meaningful place suggestions, nearby tennis courts, numbered map choices and an explicit **Use this location** confirmation. Free-text court and area fields remain available; changing them clears a selected pin. Search requests abort when replaced, closed or superseded by a new draft. Identical Nominatim/Overpass features produce one canonical choice.
- A selected public venue persists its validated coordinates, source identity, name and address in the new optional `courtPlace` field. Detail pages preview the saved pin and open Google Maps directions with `api=1` and the exact stored `lat,lng` destination. Legacy sessions without a valid pin show their existing text without inventing coordinates.
- Saved coordinates also work for distance filtering in game discovery outside Pittsburgh, before the legacy known-court matching fallback.
- General OpenStreetMap discovery is the default finder. The three original Pittsburgh courts remain a featured local collection with their official booking links. Landing, finder and game copy explain that other cities are supported.
- Selected map pins use `#D7FC83`, a check mark and `aria-pressed`. Other pins are dark and secondary. Map/list numbers match. Native 44px buttons support pointer, touch, Enter and Space; selecting a result preserves the map camera and focused marker.

## Schema and compatibility review

See [location data and migration review](location-data-migration.md) for the complete persisted shape, validation and local evidence. This is one optional additive text column with an empty default; old missing/null/empty rows remain text-only. No columns are renamed, removed or backfilled. A future authorized rollout must register the schema with the new code. Live migration and rollback were not exercised.

New detail edits use a host-authorized serialized command with an expected snapshot, canonical data and a single record update. The command rejects invalid coordinates, stale drafts, cancelled rallies and rallies whose scoring has started. New UI save messages follow a successful acknowledgement.

**Compatibility risk:** direct member/admin record patches to `court` and `location` are no longer allowed; they must use `editDetails` to keep text and coordinates together. Existing shipped title/notes-only edits remain supported. Those older direct title/notes writers do not share the command's serialization, so expected-snapshot checks are not a complete compare-and-swap guarantee against a legacy writer racing between read and update. Recurring-series templates retain their previous free-text shape; generated rallies can be edited individually.

## Interface skills applied

The existing project-local Jakub Krehel installation and `skills-lock.json` are reused; no reinstall or new dependency was needed.

| Guidance | Applied change and evidence |
| --- | --- |
| [better-interface](../.agents/skills/better-interface/SKILL.md) | Reviewed discovery → selection → create/edit → saved detail/directions, including loading, empty, failure and legacy states; prioritized stale/duplicate selection correctness before visual polish. |
| [better-layout](../.agents/skills/better-layout/SKILL.md) | Flexible search/action rows, bounded result lists, compact map previews, existing mobile list/map switch, scroll-contained forms and shared numbered choices. |
| [better-ui](../.agents/skills/better-ui/SKILL.md) | Consistent pin and list states, restrained surfaces, a secondary unselected pin, explicit native button targets and stable map lifecycle. |
| [better-accessibility](../.agents/skills/better-accessibility/SKILL.md) | Native 44px controls, accessible marker names and pressed state, visible keyboard focus, check marks in addition to color, polite search/selection status and actionable errors. |
| [better-writing](../.agents/skills/better-writing/SKILL.md) | Explicit Search places / Use this location / Get directions labels; map previews distinguished from saved selections; text-only fallback, non-local discovery and cancellation copy. |
| [better-colors](../.agents/skills/better-colors/SKILL.md) | Measured selected pin text/fill `#17231b/#d7fc83` at 14.03:1 and secondary `#f4f6ec/#24362b` at 11.75:1. Browser checks verify the actual selected fill. |

The existing typography and reduced-motion system remain in use. No animation, font, icon, geocoding service or map dependency was added. Source and browser checks do not constitute full WCAG conformance or a screen-reader walkthrough.

## Free service constraints

Search reuses the existing authenticated, cached worker endpoints for Nominatim/Overpass. It is explicitly submitted, never autocomplete or background geocoding. Public Nominatim is limited shared infrastructure: its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires application-wide pacing, caching, identification and attribution, with no client-side autocomplete. The existing command-room geocoder path and cache are retained. Availability and coverage are not guaranteed; empty/failure states allow another search or text-only entry. Provider services and tiles are mocked in browser tests.

[Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started) open directions without a Maps API key. They do not invoke a Google Maps paid API. No Google Calendar direct-save or other billable integration is enabled.

## Evidence and limits

| Check | Result |
| --- | --- |
| `npm run type-check` | Passed |
| `npm run lint` | Passed |
| `npm run test:unit -- --reporter=dot --maxWorkers=2` | 508 passed in 51 files; 0 failures |
| `node --test tests/rally.test.mjs tests/courts-games.test.mjs` | 35 passed; 0 failures |
| `npm run build` | Passed: worker, client and public prerender |
| Public Playwright with one worker | 38 passed; 0 failures |
| Local UI Playwright | 24 passed; 0 failures. Covered interactions in [browser verification](location-ux-verification.md) |
| `git diff --check` | Passed |

The [before/after screenshot gallery](screenshots/location-ux/README.md) compares PR #29 source against this follow-up at desktop and mobile sizes. Test-only records and synthetic map tiles are clearly labeled; no screenshots imply a production login or a live map-provider call. Reproduction and detailed browser evidence are recorded with the gallery and fixture documentation.

Live additive migration, authenticated multi-account synchronization, real provider availability, Google editor/directions rendering and screen-reader speech remain unverified. Browser tests validate exact generated destinations with external navigation intercepted. No production release or activation check was used as validation.
