# RallyCircle product review

Stable frontend review is `review/rallycircle-overnight-product`, based on PR #21 at `d06b1a9`. Advanced frontend review is `review/rallycircle-overnight-advanced` at `79b2d22`, based on PR #22 at `e6ff2d9`. PR #21 remains the fallback. The reviewer resumed this work after an execution allowance interruption. The original Goal was activated around 12:52 AM Eastern on November 21.

| Package | Delivered |
| --- | --- |
| App chrome and authentication | Club theme and accessible provider dialog. Invite and app navigation keyboard paths, focus restoration, short-screen scrolling, and test-account rejection recovery. Existing OAuth return routing is preserved. |
| Landing | Original generated court artwork in 7–33 KB WebP variants. Responsive image selection, direct product copy and keyboard skip link. |
| Dashboard | Upcoming and in-progress commitments, score-review links, date grouping, and a personal agenda that survives a waitlist query failure. |
| Games and courts | Search, date validation and honest distance sorting. Keyboard-operable shared map, list-first mobile views, provider failure fallback and matching map/list order. |
| Rally and match day | Draft keeps entered details when following a new court link. Host can edit title and notes on an open, unscored rally. Clearer attendance and waitlist states, chat draft protection, stale-score recovery and lazy Courtboard with cancelled gestures kept local. |
| Advanced preview | Independent profile and match-history loading, real format filters, local-time poll options, host confirmation, unread filter and notification preferences. |
| Recruiter demo | [Three-minute walkthrough](overnight-demo.md), responsive screenshot sets, local test results and the verification limits below. |

PR #25 was inspected at `254f865`. The product branch took its legacy validation, attendance deduplication and nearest-court ranking with tests. Its invalid timestamp logic and accessible court mapping were reconciled with the existing discovery changes. The independent branch was untouched. Server command-room, schema, and Muse backend changes stay outside this frontend review.

## Evidence and limits

- Stable review passed TypeScript, 170 Vitest tests, lint, 31 Node tests, and the Worker and browser builds. The rebuilt rallies route is 13.23 KB gzip, compared with 15.67 KB on the stabilization baseline. The Courtboard client chunk is loaded on demand.
- The initial combined Chromium run had 32 passing cases and one 375 px landing failure during concurrent Vite and test artifact use. Subsequent verification uses worktree-local Vite caches and separate run output. The final run passed all 34 public Chromium tests, including six widths, a short landscape form and a rejected test-account response.
- Advanced preview passed TypeScript, lint, 238 Vitest tests, 31 Node tests, and production build. Its separate public-browser startup hit a Worker timeout. Local Chromium fixtures exercised profile filters and save payload, three-option polling, and notification preferences at the six target widths.
- The asset pack has 48 stable before/after, signed-out and fixture images plus 18 separately labeled advanced fixture images. Fixture images establish layout and interaction behavior only.
- Signed-in save propagation, OAuth completion, multi-account attendance and scoring, migration and live Durable Object recovery still require an authorized disposable DeepSpace app. Issue #24 reports an app-quota blocker for owner provisioning. Use the [pre-submission verification guide](pre-submission-verification.md) for owner sign-in and rehearsal.
- GitHub draft PR creation returned Forbidden on both GraphQL and REST for the isolated reviews. Review the branches through GitHub comparisons.
