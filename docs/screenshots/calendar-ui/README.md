# Calendar and interface comparisons

The before images use source from approved release `5bd06f978753ef946aa4e31f7d037dab7f64f15d`. The after images use the feature branch. Both render the same deterministic local data in Chromium, with the America/New_York time zone and reduced motion. Desktop is 1440×1000; mobile is 390×844. Full-page captures may be taller than the viewport.

Authenticated app views use test-only SDK fixtures, not production data or live multi-account sessions. These demonstrate the actual React components and CSS, with network services mocked. The landing uses the actual public component. See [verification limits](../../interface-sprint.md#verification-and-limits).

| Surface | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | --- | --- | --- | --- |
| Landing | [Before](before/landing-desktop.png) | [After](after/landing-desktop.png) | [Before](before/landing-mobile.png) | [After](after/landing-mobile.png) |
| Rally discovery and detail | [Before](before/rallies-desktop.png) | [After](after/rallies-desktop.png) | [Before](before/rallies-mobile.png) | [After](after/rallies-mobile.png) |
| Find games | [Before](before/games-desktop.png) | [After](after/games-desktop.png) | [Before](before/games-mobile.png) | [After](after/games-mobile.png) |
| Dashboard | [Before](before/dashboard-desktop.png) | [After](after/dashboard-desktop.png) | [Before](before/dashboard-mobile.png) | [After](after/dashboard-mobile.png) |
| Courtboard | [Before](before/courtboard-desktop.png) | [After](after/courtboard-desktop.png) | [Before](before/courtboard-mobile.png) | [After](after/courtboard-mobile.png) |
| Chat | [Before](before/chat-desktop.png) | [After](after/chat-desktop.png) | [Before](before/chat-mobile.png) | [After](after/chat-mobile.png) |

To capture current screenshots, start the test-only server in one terminal:

```powershell
npm exec -- vite --config tests/ui-fixtures/vite.config.ts --port 5182 --strictPort --host 127.0.0.1
```

Then run `node tests/ui-fixtures/capture.mjs after` in another terminal. Reconstructing the approved baseline additionally requires archived approved JSX for Tailwind's source scan; follow the fixture documentation. Neither server invokes DeepSpace integrations or accesses production records.

See the [fixture instructions](../../../tests/ui-fixtures/README.md) for the exact approved-source archive commands, alternate ports, state queries and verification limits.
