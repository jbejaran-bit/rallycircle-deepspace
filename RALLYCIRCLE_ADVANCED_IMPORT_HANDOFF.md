# Muse advanced backend import

The isolated review branch starts at `b15852bf421fe42cc321d91704f53e6515acdf30`, the published head of PR #14. [Review the changes](https://github.com/jbejaran-bit/rallycircle-deepspace/compare/feature/codex-complete-rallycircle...integration/rallycircle-advanced-review?expand=1)

## Archive access

The supplied archive download returned HTTP 403. A read-only diagnostic reported `CONNECT tunnel failed, response 403` from the cloud proxy, before Muse served the file. The archive was unavailable for preservation, checksum verification, Git import, or contract review. Refreshed GitHub refs and workspace uploads contained the earlier Muse tracks but no copy of the advanced archive or its seven branches.

Upload `rallycircle-advanced-backend-2026-11-20.tar.gz` directly to resume. With a local copy, list and validate paths and file types, extract into an isolated directory, validate the checksum manifest and bundle tip identities, then inspect the contracts and history on separate refs. Integrate verified stabilization first. Keep the experimental tracks on separate review branches.

## Independent stabilization

- `b455b7c` lets a player withdraw or leave the waitlist after a cancellation, including legacy records with invalid stored capacity. Invalid capacity still blocks new responses, and the cleanup path cannot promote waitlisted players. The existing command remains authenticated and scoped to the caller. The authenticated collaboration spec now checks the cancelled-session withdrawal workflow.
- `c886072` keeps the personal schedule independent of community attendance. The dashboard shows a distinct loading or error state for community counts and avoids treating a failed query as zero attendance.

These changes introduce no schemas, migrations, dependencies, new permissions, or experimental feature activation.

## Verification

- `npm run validate` passed TypeScript and 125 Vitest tests.
- `npm run lint`, `node --test tests/*.test.mjs` (31 tests), and `npm run build` passed.
- `npm run test:public` passed 22 Chromium tests using system Chromium and writable Wrangler paths.
- Local preview returned 401 for signed-out rally command, geocoding, and nearby courts requests.
- `npm test` reported `not_authenticated` before running any specs. Authenticated browser behavior, real-time synchronization, and the previous additive schema migration remain pending.
- Public desktop and signed-out mobile screenshots are in `/workspace/shared/rallycircle-advanced-review`.
