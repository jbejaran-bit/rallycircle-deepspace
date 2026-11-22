# Interface implementation evidence

This sprint refines the existing React/Tailwind/Base UI interface: landing, discovery, rally detail, dashboard, Courtboard/chat, shared navigation and controls. It preserves the club theme, tennis photography, existing routes and product behavior. The baseline is approved commit `5bd06f978753ef946aa4e31f7d037dab7f64f15d`; this is an implementation assessment of that interface, not a separate change-scoped review.

Project conventions inspected: `AGENTS.md`, `README.md`, `src/themes.css`, the local UI primitives and the existing public Playwright suites. The official DeepSpace [product polish documentation](https://docs.deep.space/design/product-polish.md) was also read. No separate project typography or content style guide was found.

## Installed skills and application

The official [jakubkrehel/skills repository](https://github.com/jakubkrehel/skills) was installed **only in the isolated worktree**, using the documented command with explicit selections:

```powershell
npx.cmd skills add jakubkrehel/skills --skill better-interface better-ui better-layout better-typography better-colors better-accessibility better-writing better-motion --agent codex --copy --yes
```

All eight `SKILL.md` files were read before implementation. [`skills-lock.json`](../skills-lock.json) records source commit `672ae44ace6aaed65b86cbb1e2fd6fbea0e79578`, each source path, content hash and copy mode. The committed local copies and lock preserve the instructions actually applied; a future unpinned `skills add` can retrieve newer upstream instructions.

| Installed guidance | Concrete application and evidence |
| --- | --- |
| [`better-interface`](../.agents/skills/better-interface/SKILL.md) | Recon across the seven owning domains, then one ranked implementation scope below. Retained existing stack and prioritized interaction correctness over polish. |
| [`better-accessibility`](../.agents/skills/better-accessibility/SKILL.md) | Native links/buttons and existing Base UI focus behavior retained; native-control focus fallback, forced-colors focus, mobile input sizing and reduced-motion reset in `src/styles.css`. Existing skip links and navigation test hooks preserved. |
| [`better-layout`](../.agents/skills/better-layout/SKILL.md) | Shared alignment edges, flexible control rows, `minmax(0, 1fr)` tracks and narrow-screen stacking. Landing groups explanatory content in a calm list; Button uses minimum height and wrapping so labels can grow. Full account details remain available in its popup. |
| [`better-writing`](../.agents/skills/better-writing/SKILL.md) | Existing vocabulary and verb-first landing routes retained. Calendar actions name their actual destination/output: “Add to Google Calendar” and “Download .ics”; no success claim for opening a draft. Empty and pending states remain actionable. |
| [`better-typography`](../.agents/skills/better-typography/SKILL.md) | Reused the existing system font, reduced display scale, descending page/detail headings, unitless line heights, bounded paragraph measures and deliberate wrapping. Inputs remain at least 16px on narrow screens. |
| [`better-colors`](../.agents/skills/better-colors/SKILL.md) | Landing now consumes the existing semantic club tokens; preserved dark green/lime identity. Measured declared text/focus pairs and lifted the field boundary token to a verified value, below. |
| [`better-ui`](../.agents/skills/better-ui/SKILL.md) | Consistent rounded controls, larger account/menu targets, pointer-capable hover styling, inset white 10% image outline, absolute icon stroke widths on landing and contained overlay scrolling. No new icon library or UI dependency. |
| [`better-motion`](../.agents/skills/better-motion/SKILL.md) | Replaced shared Button `transition-all` with explicit color transitions at 150ms/ease-out. Landing uses brief color feedback and no entrance choreography. Motion-safe navigation rotation and a global reduced-motion fallback cover existing CSS movement and smooth scrolling. |

## Ranked baseline findings and implemented response

Locations in this table refer to the approved baseline, so the assessment remains reproducible after line numbers move.

| Severity | Domain | Baseline location | Before | Implemented response | User impact |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility / motion | `src/styles.css:163` | Unconditional `scroll-behavior: smooth`, without a reduced-motion fallback | Explicit reduced-motion reset for scrolling, CSS transitions and animation | Honors the system preference instead of moving the page during anchor navigation. |
| HIGH | Colors / accessibility | `src/themes.css:68`, transparent input boundaries on club card/popover surfaces | `#577061` on `#192820` computes to **2.85:1**, below the 3:1 boundary target | `--color-input: #738078`, **3.73:1** on the same surface | Input boundaries remain distinguishable on raised dark surfaces (WCAG 1.4.11). This is a declared-pair measurement, not a blanket browser accessibility claim. |
| MEDIUM | Writing | `src/pages/(app)/(protected)/rallies.tsx:420` | “Add to calendar” downloads an ICS file | Explicit Google Calendar action and separate ICS export | People can predict whether an action opens Google or downloads a file. |
| MEDIUM | Typography / layout | `src/pages/(app)/(protected)/rallies.tsx:609` | “Rally sessions” reaches `text-6xl`; detail title and action cluster compete for attention | Moderate page heading, clearer detail metadata and grouped actions | Improves scanning of the actual session content and next action. |
| MEDIUM | Colors / typography | `src/pages/landing.css:2,22` | Cream landing with a 7rem serif display shifts abruptly into the dark club app | Existing dark/lime tokens and system type, with a 5.25rem display ceiling | Gives the landing and app a consistent product identity while preserving content and court imagery. |
| LOW | Motion / UI | `src/components/ui/Button.tsx:7` | `transition-all`, fixed-height controls and unwrappable labels | Exact color transitions and flexible minimum-height controls | Avoids unintended animation and leaves room for long labels and text growth. |

## Measured palette pairs

Calculated with the WCAG 2 sRGB linearization and relative-luminance formula, using the actual declared opaque club tokens. These are source-token measurements; translucent overlays, map tiles, avatars and arbitrary user images require their own rendered checks.

| Foreground / boundary | Background | Ratio | Role |
| --- | --- | --- | --- |
| `#f4f6ec` | `#101b14` | 16.18:1 | Body text |
| `#b7c6b9` | `#101b14` | 9.92:1 | Secondary text |
| `#b7c6b9` | `#192820` | 8.63:1 | Secondary text on cards |
| `#182311` | `#d7fc83` | 14.09:1 | Primary button label |
| `#d7fc83` | `#192820` | 13.28:1 | Focus/accent on cards |
| `#738078` | `#192820` | 3.73:1 | Input boundary on cards |
| `#738078` | `#24362b` | 3.11:1 | Input boundary on secondary surfaces |

## Verification and limits

Before screenshots in [`screenshots/calendar-ui/before/`](screenshots/calendar-ui/before/) load source pinned to the approved commit. Authenticated-looking rally, dashboard, Courtboard and chat screenshots use explicit local SDK fixtures, not production records or a successful live sign-in. The fixture source and capture script are under `tests/ui-fixtures/`. After screenshots use current source with the same fixture data and viewport sizes.

Scoped implementation checks: `npm run type-check`, ESLint on the landing/navigation/Button files and `git diff --check` passed. After landing screenshots were visually inspected at 1440px desktop and 390px mobile: the hero, imagery, action hierarchy and text remain readable without clipping. The local fixture reflow checks also passed at 320, 390, 768 and 1440px for landing, rallies and dashboard. Full suite counts, runtime browser results and calendar checks are recorded in the sprint handoff; this document does not replace that evidence.

**Not verified here:** a screen-reader walkthrough, live authenticated multi-account operations, translated content, arbitrary user images, and every light-theme surface. The source and fixture checks do not establish a full WCAG conformance claim. No deployment, production configuration/data change, paid event creation or billable integration call was part of this design work.

### Browser measurements

`node tests/ui-fixtures/audit.mjs` measured computed colors on the actual landing backgrounds in Chromium. Club landing body/secondary copy and navigation measure **9.92:1**, the primary action label **14.09:1**, and secondary action labels **16.18:1**. The sampled slate landing pairs have a minimum **6.12:1**; sampled paper pairs have a minimum **7.81:1**. These samples all exceed 4.5:1 for normal text. They do not cover arbitrary images or translucent app overlays.

The focused primary action rendered a **2px lime outline with 4px offset** and a **44px minimum target height**. Computed body, navigation and rally metadata font families resolve to the existing system sans stack in both captures. Approved rally heading size is **60px** at 1440px; the refined page heading is **36px**. The approved desktop rally grid was verified as **506.594px / 685.406px** after explicitly scanning the archived baseline JSX, preventing missing Tailwind utilities from distorting comparisons.
