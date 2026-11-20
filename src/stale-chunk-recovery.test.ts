import { describe, expect, it, vi } from 'vitest'
import { installStaleChunkRecovery } from './stale-chunk-recovery'

type State = { initialized: boolean; errors: unknown }
type Options = NonNullable<Parameters<typeof installStaleChunkRecovery>[1]>

function start(storage: Options['storage']) {
  let onPreloadError: Parameters<Options['onPreloadError']>[0] = () => {}
  let onNavigation: (state: State) => void = () => {}
  const stop = vi.fn()
  const reload = vi.fn()
  installStaleChunkRecovery({
    state: { initialized: false, errors: null },
    subscribe(listener) {
      onNavigation = listener
      return stop
    },
  }, {
    storage,
    reload,
    onPreloadError(listener) { onPreloadError = listener },
  })
  return { error: onPreloadError, navigate: onNavigation, reload, stop }
}

function tabStorage(): NonNullable<Options['storage']> {
  const data = new Map<string, string>()
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  }
}

describe('stale chunk recovery', () => {
  it('reloads once across a persistent failure and exposes the second error', () => {
    const storage = tabStorage()
    const first = start(storage)
    const preventDefault = vi.fn()
    first.error({ preventDefault })
    first.error({ preventDefault })
    expect(first.reload).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()

    const reloaded = start(storage)
    reloaded.navigate({ initialized: true, errors: { route: 'unavailable' } })
    reloaded.error({ preventDefault })
    expect(reloaded.reload).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('allows one recovery again after the router successfully initializes', () => {
    const storage = tabStorage()
    start(storage).error({ preventDefault: vi.fn() })
    const reloaded = start(storage)
    reloaded.navigate({ initialized: true, errors: null })
    expect(reloaded.stop).toHaveBeenCalledOnce()
    reloaded.error({ preventDefault: vi.fn() })
    expect(reloaded.reload).toHaveBeenCalledOnce()
  })

  it('does not reload when storage cannot persist the guard', () => {
    const storage = tabStorage()
    storage.setItem = () => { throw new Error('Storage denied') }
    const tab = start(storage)
    const preventDefault = vi.fn()
    tab.error({ preventDefault })
    expect(tab.reload).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
