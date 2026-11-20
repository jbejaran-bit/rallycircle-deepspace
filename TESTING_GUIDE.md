# RallyCircle testing guide

Use Node 24, npm 11.6 or newer, and the checked-in lockfile. Run commands from the repository root.

## Offline checks

```sh
npm ci
npm run validate
node --test tests/rally.test.mjs
npm run lint
npm run build
```

Vitest runs real Hono handlers, the Rally command room with in-memory record storage, SDK permission helpers, React static rendering, and stale-chunk recovery. Test doubles stand in for the auth provider, storage, and browser callbacks. These tests exercise the app's logic without relying on remote records, OAuth callbacks, or Durable Object runtime behavior. Node tests use a fixed clock for session validation and check invitation encoding, attendance, and readiness.

## Public browser checks

```sh
npx playwright install chromium
npm run test:public
```

The public config starts its own Vite server and binds to loopback. It does not require a DeepSpace login or wait on the auth worker. It checks public landing behavior, signed-out route protection, and mobile navigation. It starts with fresh browser contexts and writes failure traces to `test-results/public`. In cloud environments with system Chromium and a restricted home directory, use the cloud setup below instead of installing a second browser.

```sh
export XDG_CONFIG_HOME=/workspace/.rallycircle-config
export WRANGLER_LOG_PATH=/tmp/rallycircle-wrangler.log
export DEEPSPACE_TEST_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
mkdir -p "$XDG_CONFIG_HOME"
DEEPSPACE_PORT=5187 npm run test:public
```

A busy port causes a startup failure on purpose. Use a free port or stop the server you started. A signed-out check can pass with a missing local auth binding because the protected UI fails closed. Checking the real auth worker requires the integration suite.

## Real DeepSpace checks

Use a developer session already authorized for this app and two usable test accounts. Follow the DeepSpace testing guide for account provisioning, and keep credentials and generated `.dev.vars` out of Git. Use separate test data and leave `RALLYCIRCLE_TEST_URL` unset for local runs. Stop any dev server on the integration runner's selected port first.

```sh
npx deepspace auth whoami
npx deepspace test accounts list --usable
npm run test:api
npm test -- tests/rally-collab.spec.ts
```

The test runner waits on `/api/auth/ok`. A timeout here means specs never started. Check the local environment binding, workerd DNS and outbound connectivity, and CLI authorization before debugging assertions. Browser sign-in, confirmed writes, presence, and multi-account realtime delivery require functional DeepSpace services. If only the signed-out Hono or browser tests passed, report the remaining authenticated paths as unverified.

The collaboration spec publishes a uniquely labeled future session and cancels it in a `finally` block once creation has been confirmed. Cancellation preserves an audit record and its existing history. If the run dies mid-creation or cleanup, check for the labeled session in the authorized test app and cancel it as the host. Avoid pointing mutating tests at the public app.

The separate Live Courtboard draft adds its own suite. Run it only from that branch or an integration branch with its code and authorized accounts.

[DeepSpace testing guide](https://docs.deep.space/guides/testing)
