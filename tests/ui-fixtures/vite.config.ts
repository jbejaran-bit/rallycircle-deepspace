import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../../', import.meta.url))
const before = process.env.RALLYCIRCLE_UI_BASELINE === '1'
const baselineRef = process.env.RALLYCIRCLE_UI_BASELINE_REF ?? '5bd06f978753ef946aa4e31f7d037dab7f64f15d'

export default defineConfig({
  root,
  cacheDir: `${root}/.vite/ui-fixtures`,
  plugins: [
    before && {
      name: 'approved-release-ui-baseline',
      enforce: 'pre',
      load(id) {
        const relative = id.replaceAll('\\', '/').split('?')[0].slice(root.replaceAll('\\', '/').length)
        if (!relative.startsWith('src/') || !/\.(tsx?|css)$/.test(relative)) return
        try {
          const source = execFileSync('git', ['show', `${baselineRef}:${relative}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          // The approved JSX may use utilities no longer present in current
          // sources. Include its snapshot in Tailwind's scan for faithful CSS.
          return relative === 'src/styles.css' ? `${source}\n@source "../test-results/ui-baseline/src/**/*.{ts,tsx}";` : source
        }
        catch { return }
      },
    },
    react(),
  ],
  define: { __DEEPSPACE_APP_ID__: JSON.stringify('local-ui-fixture-no-services') },
  resolve: { alias: [
    { find: /^deepspace$/, replacement: `${root}/tests/ui-fixtures/deepspace.ts` },
    { find: '@', replacement: `${root}/src` },
  ] },
})
