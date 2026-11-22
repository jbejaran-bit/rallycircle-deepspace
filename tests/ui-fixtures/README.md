# Local UI verification fixtures

This entry renders the real landing, navigation, rally, dashboard, game discovery, Courtboard and chat components with deterministic SDK replacements. It is outside `src/pages`, is not a product route, and is never imported by the production entry or build. The fixture Vite config does not start Cloudflare or load production credentials. Its `deepspace` alias provides local records, presence, canvas and message mutations; all catalog integration methods refuse calls.

The fixture proves rendering and client interaction behavior. It does **not** prove production authorization, live multi-account synchronization, server attendance serialization, real message delivery or successful Google OAuth/event creation. Server command tests cover the corresponding local server logic. Public browser checks exercise the normal app independently.

## Browser checks

```powershell
npm run test:ui
npm run test:public -- --workers=1
```

`test:ui` owns port 5183 by default (`RALLYCIRCLE_UI_PORT` overrides it), runs one worker, and intercepts action requests with local fixture responses. The Google Calendar link is actually clicked into a new tab, but the external destination is intercepted and fulfilled locally. No Google request, event save or billable integration occurs in that test. The ICS link is clicked and Chromium's real download event is checked.

## Reproduce screenshots

Prepare the approved source snapshot for Tailwind scanning. These PowerShell commands only create ignored files inside this worktree:

```powershell
New-Item -ItemType Directory -Force test-results | Out-Null
git archive --format=zip --output=test-results/ui-baseline.zip 5bd06f978753ef946aa4e31f7d037dab7f64f15d src
Expand-Archive -LiteralPath test-results/ui-baseline.zip -DestinationPath test-results/ui-baseline -Force
$env:RALLYCIRCLE_UI_BASELINE='1'
npm exec -- vite --config tests/ui-fixtures/vite.config.ts --port 5182 --strictPort --host 127.0.0.1
```

In a second PowerShell terminal:

```powershell
node tests/ui-fixtures/capture.mjs before
```

The baseline plugin loads source text directly from the approved Git commit. It also scans the archived approved JSX for old Tailwind utilities, so removed responsive classes are still compiled faithfully. This does not check out or modify the approved worktree. The snapshot remains outside Playwright's rotated `test-results/ui-polish` output.

Stop that Vite process, or start the current-source preview separately in a terminal without `RALLYCIRCLE_UI_BASELINE=1`:

```powershell
Remove-Item Env:RALLYCIRCLE_UI_BASELINE -ErrorAction SilentlyContinue
npm exec -- vite --config tests/ui-fixtures/vite.config.ts --port 5184 --strictPort --host 127.0.0.1
```

In another terminal:

```powershell
$env:RALLYCIRCLE_FIXTURE_URL='http://127.0.0.1:5184'
node tests/ui-fixtures/capture.mjs after
node tests/ui-fixtures/audit.mjs
```

Capture writes desktop 1440×1000 and mobile 390×844 full-page PNGs to `docs/screenshots/calendar-ui/{before,after}` using `America/New_York` and reduced motion. Courtboard and chat also have cropped component captures. Audit writes computed landing color/contrast and focus data to ignored `test-results/ui-runtime-audit.json`.

## Fixture states

Open `/tests/ui-fixtures/index.html?view=rallies` on the fixture server. `view` also accepts `landing`, `dashboard` and `games`. Optional query parameters: `detail=1`, `empty=1`, `loading=1`, `error=1`, `cancelled=1`, `sendError=1`, `user=bob` (confirmed player), and `user=visitor` (full session/waitlist). The default user is the host, Alice, displayed as Alex Morgan. Example dates are fixed in June 2030; these are synthetic records, not production events.

The native browser Google editor walk-through could not be completed in this environment. The generated Google target, exact UTC duration, browser time zone, court, notes, invitation and popup behavior were verified locally; Google's rendered editor and live save remain unverified.
