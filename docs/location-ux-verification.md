# Location UX verification

The comparison baseline is PR #29, commit `20f8fd10998f08138c2eba199a7b699845230a98`. This follow-up is developed in `C:/dev/rallycircle-location-ux` on `feature/court-location-map-ux-20261122`. Browser fixtures render the real React components and Leaflet implementation with local SDK records and intercepted discovery responses. They do not connect to a DeepSpace account, create production records, use Google OAuth or call a paid integration.

## Checks and scope

- Public browser suite: **38 passed, 0 failed**, using `DEEPSPACE_PORT=5195 npm run test:public -- --workers=1`. Local `AUTH_WORKER_URL` warnings were expected; signed-out navigation, sign-in gates, landing, focus, contrast and public route behavior passed without credentials.
- Local component suite: **24 passed, 0 failed** after the source freeze (1.6 minutes), using `RALLYCIRCLE_UI_PORT=5193 npm run test:ui -- --reporter=line`. The suite runs one worker against a fixture-only Vite server. Tests inspect actual map controls, keyboard/touch activation and rendered links; they do not substitute a fake map component. Scoped ESLint on the changed fixture/spec files and `git diff --check` also passed.
- [Before/after screenshots](screenshots/location-ux/README.md) use identical synthetic records and intercepted Nominatim, nearby-court and map-tile responses. Locations in these fixtures are test data rather than verified live venue listings. Desktop is 1440×1000; mobile is 390×844, with America/New_York and reduced motion.

The location checks cover default city discovery, the featured Pittsburgh collection and official booking URL, stable map/list numbering, lime selection, native keyboard/touch interaction, directions with stored coordinates, empty/failed/stale searches, duplicate OSM identities, external sample-draft changes, creation/editing, fixture persistence, stable invitation URLs, legacy text-only records and clearing pins when text changes. The existing calendar, attendance, waitlist, message draft and Courtboard component regressions remain in the suite.

The creation/edit tests check submitted action payloads and the UI reading accepted stored values, including a fixture reload. This is local browser persistence against a mock service, **not** evidence of a deployed schema migration or live server persistence. The separate server tests provide local validation/authorization/persistence evidence.

## Interface guidance applied

The existing installed skill files were read and used for this location-flow verification:

| Guidance | Concrete check |
| --- | --- |
| `better-interface` | Scoped the implementation assessment to complete discovery → selection → rally flows, including legacy, empty and error states; did not claim review of unrelated app surfaces. |
| `better-layout` | Checked reflow at 320, 390, 768 and 1440px, mobile map/list switching, and 320px dialog scrolling with Save/Publish reachable by keyboard. |
| `better-ui` | Inspected selected/secondary map pin shapes, 44px target dimensions, map/list number consistency, and actual desktop/mobile screenshots. |
| `better-accessibility` | Exercised native Enter/Space and touch activation, retained focus after selection, visible focus outline, tab navigation and explicit selected text/state. |
| `better-writing` | Checked labels against their actions, city-independent discovery copy, search recovery instructions, precise directions and the absence of the removed ICS action. |
| `better-colors` | Computed contrast from rendered opaque pin foreground/fill values rather than estimating colors or measuring against the page background. |

Measured on the rendered native map buttons using `node tests/ui-fixtures/location-audit.mjs`: selected foreground `rgb(23,35,27)` on `rgb(215,252,131)` is **14.03:1**; secondary foreground `rgb(244,246,236)` on `rgb(36,54,43)` is **11.75:1**. Both measured targets are **44×44px**. Keyboard modality yields a **3px solid** focus outline with 2px offset and lime halo. These are specific rendered-pair measurements, not a claim of whole-app WCAG conformance.

## Reproduce

```powershell
npm run test:ui
$env:DEEPSPACE_PORT='5195'
npm run test:public -- --workers=1
```

For the PR #29 screenshot baseline, create an ignored snapshot for Tailwind's source scan:

```powershell
New-Item -ItemType Directory -Force test-results | Out-Null
git archive --format=zip --output=test-results/ui-baseline.zip 20f8fd10998f08138c2eba199a7b699845230a98 src
Expand-Archive -LiteralPath test-results/ui-baseline.zip -DestinationPath test-results/ui-baseline -Force
$env:RALLYCIRCLE_UI_BASELINE='1'
$env:RALLYCIRCLE_UI_BASELINE_REF='20f8fd10998f08138c2eba199a7b699845230a98'
npm exec -- vite --config tests/ui-fixtures/vite.config.ts --port 5192 --strictPort --host 127.0.0.1
```

In another terminal, `node tests/ui-fixtures/location-capture.mjs before` writes the baseline images. The baseline plugin reads source directly from Git and scans the approved JSX, without checking out or modifying the approved deployment worktree.

For current-source captures, launch the fixture server in a terminal without the baseline environment variables on port 5194, then run:

```powershell
$env:RALLYCIRCLE_FIXTURE_URL='http://127.0.0.1:5194'
node tests/ui-fixtures/location-capture.mjs after
node tests/ui-fixtures/location-audit.mjs
```

## Limits

No deployed migration, live multi-account synchronization, real Nominatim/Overpass/tile uptime or real Google Calendar save was tested. External Google calendar navigation is intercepted in the automated popup test. Existing authenticated `deepspace/testing` specs were adjusted for the new default/featured tab labels but were not executed against live test accounts. Screen-reader speech, a physical touch device, browser zoom, translated content and RTL remain unverified. Public services' coverage and venue access information can vary; fixture success does not establish live location-data accuracy.

The authenticated test configuration explicitly excludes `ui-polish.spec.ts` and `location-ux.spec.ts`; those are owned by `test:ui` and its separate fixture server. The unrun live court/rally specs use semantic Court/Area/search labels and inspect the Google draft URL rather than expecting the removed ICS download.

No deployment, merge, production data change, billable API invocation, activation retry or internship submission was performed.
