import { expect, test } from 'deepspace/testing'
import type { Page } from '@playwright/test'

test('session courtboard is private, synchronized, persistent, and isolated', async ({ users, page }) => {
  test.setTimeout(180_000)
  const [alice, bob] = await users(2)
  const firstTitle = `__test-courtboard-${Date.now()}__`
  const secondTitle = `${firstTitle}-isolated`
  let firstSessionId: string | null = null
  let secondSessionId: string | null = null
  let canvasSocketUrl: string | null = null
  let heldSocketOpened = false

  alice.page.setDefaultTimeout(30_000)
  bob.page.setDefaultTimeout(30_000)
  await alice.page.setViewportSize({ width: 1440, height: 1000 })
  await bob.page.setViewportSize({ width: 390, height: 844 })
  alice.page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.includes('/ws/canvas/')) canvasSocketUrl = socket.url()
  })

  try {
    const firstUrl = await createSession(alice.page, firstTitle)
    firstSessionId = firstUrl.searchParams.get('session')
    expect(firstSessionId).toBeTruthy()
    await expect(alice.page.getByTestId('courtboard-status')).toContainText('Connected · editing enabled')
    expect(await alice.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440)

    await page.goto(firstUrl.toString())
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
    const anonymousStatus = await page.evaluate(async (socketUrl) => {
      if (!socketUrl) throw new Error('Alice did not open a Canvas socket.')
      const url = new URL(socketUrl)
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
      url.searchParams.delete('token')
      return (await fetch(url)).status
    }, canvasSocketUrl)
    expect(anonymousStatus).toBe(401)
    const anonymousSocket = await page.evaluate((socketUrl) => {
      if (!socketUrl) throw new Error('Alice did not open a Canvas socket.')
      const url = new URL(socketUrl)
      url.searchParams.delete('token')
      return trySocket(url)

      function trySocket(target: URL): Promise<'open' | 'error' | 'closed' | 'timeout'> {
        return new Promise((resolve) => {
          const socket = new WebSocket(target)
          let finished = false
          const finish = (result: 'open' | 'error' | 'closed' | 'timeout') => {
            if (finished) return
            finished = true
            window.clearTimeout(timeout)
            if (socket.readyState < WebSocket.CLOSING) socket.close()
            resolve(result)
          }
          const timeout = window.setTimeout(() => finish('timeout'), 5000)
          socket.addEventListener('open', () => finish('open'), { once: true })
          socket.addEventListener('error', () => finish('error'), { once: true })
          socket.addEventListener('close', () => finish('closed'), { once: true })
        })
      }
    }, canvasSocketUrl)
    expect(anonymousSocket).not.toBe('open')

    const inviteUrl = `${firstUrl.pathname}${firstUrl.search}`
    await bob.page.goto(inviteUrl)
    await expect(bob.page.getByTestId('courtboard-denied')).toBeVisible()
    const nonmemberResult = await bob.page.evaluate(async (socketUrl) => {
      if (!socketUrl) throw new Error('Alice did not open a Canvas socket.')
      const sdkUrl = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
      const sdk = await import(sdkUrl)
      const token = await sdk.getAuthToken()
      if (!token) throw new Error('Bob did not have an auth token.')
      const wsUrl = new URL(socketUrl)
      wsUrl.searchParams.set('token', token)
      const requestUrl = new URL(wsUrl)
      requestUrl.protocol = requestUrl.protocol === 'wss:' ? 'https:' : 'http:'
      return {
        status: (await fetch(requestUrl)).status,
        socket: await new Promise<'open' | 'error' | 'closed' | 'timeout'>((resolve) => {
          const socket = new WebSocket(wsUrl)
          let finished = false
          const finish = (result: 'open' | 'error' | 'closed' | 'timeout') => {
            if (finished) return
            finished = true
            window.clearTimeout(timeout)
            if (socket.readyState < WebSocket.CLOSING) socket.close()
            resolve(result)
          }
          const timeout = window.setTimeout(() => finish('timeout'), 5000)
          socket.addEventListener('open', () => finish('open'), { once: true })
          socket.addEventListener('error', () => finish('error'), { once: true })
          socket.addEventListener('close', () => finish('closed'), { once: true })
        }),
      }
    }, canvasSocketUrl)
    expect(nonmemberResult.status).toBe(403)
    expect(nonmemberResult.socket).not.toBe('open')

    await bob.page.getByRole('button', { name: /I.m in/i }).click()
    await expect(bob.page.getByTestId('courtboard-status')).toContainText('Connected · editing enabled')
    await expect(alice.page.getByTestId('readiness-count')).toHaveText('2 / 4 confirmed')
    heldSocketOpened = await bob.page.evaluate(async (socketUrl) => {
      if (!socketUrl) throw new Error('Alice did not open a Canvas socket.')
      const sdkUrl = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
      const sdk = await import(sdkUrl)
      const token = await sdk.getAuthToken()
      if (!token) throw new Error('Bob did not have an auth token.')
      const url = new URL(socketUrl)
      url.searchParams.set('token', token)
      const socket = new WebSocket(url)
      const opened = await new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 5000)
        socket.addEventListener('open', () => {
          window.clearTimeout(timeout)
          resolve(true)
        }, { once: true })
        socket.addEventListener('error', () => {
          window.clearTimeout(timeout)
          resolve(false)
        }, { once: true })
      })
      if (!opened) {
        socket.close()
        return false
      }
      Object.defineProperty(window, '__courtboardTestSocket', { value: socket, configurable: true })
      return true
    }, canvasSocketUrl)
    expect(heldSocketOpened).toBe(true)

    await alice.page.getByTestId('courtboard-add-A1').click()
    const aliceMarker = alice.page.getByTestId('courtboard-marker-A1')
    const bobMarker = bob.page.getByTestId('courtboard-marker-A1')
    await expect(aliceMarker).toBeVisible()
    await expect(bobMarker).toBeVisible()
    await alice.page.getByTestId('courtboard-panel').screenshot({ path: 'test-results/courtboard-desktop.png' })
    await bob.page.getByTestId('courtboard-panel').screenshot({ path: 'test-results/courtboard-mobile.png' })
    expect(await bob.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    const touchMove = await bob.page.evaluate(() => {
      const marker = document.querySelector<SVGGElement>('[data-testid="courtboard-marker-A1"]')
      const svg = document.querySelector<SVGSVGElement>('[data-testid="courtboard-court"]')
      if (!marker || !svg) throw new Error('Courtboard marker or court was not rendered.')
      const bounds = svg.getBoundingClientRect()
      const x = Number(marker.getAttribute('data-x'))
      const y = Number(marker.getAttribute('data-y'))
      const startX = bounds.left + (x / 1000) * bounds.width
      const startY = bounds.top + (y / 500) * bounds.height
      const endX = bounds.left + bounds.width * 0.67
      const endY = bounds.top + bounds.height * 0.43
      marker.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        clientX: startX, clientY: startY, buttons: 1,
      }))
      svg.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        clientX: endX, clientY: endY, buttons: 1,
      }))
      svg.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true,
        clientX: endX, clientY: endY,
      }))
      return {
        x: Math.round(Math.min(900, Math.max(100, ((endX - bounds.left) / bounds.width) * 1000))),
        y: Math.round(Math.min(430, Math.max(70, ((endY - bounds.top) / bounds.height) * 500))),
      }
    })
    await expect(bobMarker).toHaveAttribute('data-x', String(touchMove.x))
    await expect(bobMarker).toHaveAttribute('data-y', String(touchMove.y))
    await expect(aliceMarker).toHaveAttribute('data-x', String(touchMove.x))
    await expect(aliceMarker).toHaveAttribute('data-y', String(touchMove.y))

    await alice.page.reload()
    await expect(alice.page.getByTestId('courtboard-status')).toContainText('Connected · editing enabled')
    await expect(aliceMarker).toHaveAttribute('data-x', String(touchMove.x))
    await expect(aliceMarker).toHaveAttribute('data-y', String(touchMove.y))

    await aliceMarker.focus()
    await aliceMarker.press('ArrowRight')
    const keyboardX = touchMove.x + 12
    await expect(aliceMarker).toHaveAttribute('data-x', String(keyboardX))
    await expect(bobMarker).toHaveAttribute('data-x', String(keyboardX))

    await bobMarker.click()
    await bob.page.getByTestId('courtboard-remove-selected').click()
    await expect(aliceMarker).toHaveCount(0)
    await expect(bobMarker).toHaveCount(0)

    await Promise.all([
      addMarkerFromSocket(alice.page, canvasSocketUrl, 'A1'),
      addMarkerFromSocket(bob.page, canvasSocketUrl, 'A1'),
    ])
    await expect(aliceMarker).toHaveCount(1)
    await expect(bobMarker).toHaveCount(1)

    const secondUrl = await createSession(alice.page, secondTitle)
    secondSessionId = secondUrl.searchParams.get('session')
    expect(secondSessionId).toBeTruthy()
    await expect(alice.page.getByTestId('courtboard-status')).toContainText('Connected · editing enabled')
    await expect(alice.page.getByTestId('courtboard-marker-A1')).toHaveCount(0)

    await alice.page.goto(inviteUrl)
    await expect(alice.page.getByTestId('courtboard-marker-A1')).toBeVisible()

    if (!firstSessionId) throw new Error('The first session was not created.')
    await cancelSession(alice.page, firstSessionId)
    firstSessionId = null
    await expect(alice.page.getByTestId('courtboard-status')).toContainText('Connected · read-only')
    await expect(bob.page.getByTestId('courtboard-status')).toContainText('Connected · read-only')
    await expect(alice.page.getByTestId('courtboard-add-A2')).toBeDisabled()

    const writeAfterCancellation = await bob.page.evaluate(async () => {
      const socket = Reflect.get(window, '__courtboardTestSocket')
      if (!(socket instanceof WebSocket) || socket.readyState !== WebSocket.OPEN) {
        throw new Error('The held Canvas connection was not left open for the security check.')
      }
      const sdkUrl = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
      const sdk = await import(sdkUrl)
      const message = sdk.clientBuild.canvasAdd({
        type: 'rally-player',
        x: 700,
        y: 200,
        width: 72,
        height: 72,
        props: { label: 'A2', color: '#b7eb66' },
      })
      return new Promise<{ type: string; error?: string }>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('The server did not reject the write in time.')), 5000)
        socket.addEventListener('message', (event) => {
          const response = JSON.parse(event.data)
          if (response.type !== 'core.error') return
          window.clearTimeout(timeout)
          resolve({ type: response.type, error: response.payload?.error })
        })
        socket.send(sdk.encode(message))
      })
    })
    expect(writeAfterCancellation).toMatchObject({
      type: 'core.error',
      error: 'Write access denied: viewer role cannot modify the canvas',
    })
    await expect(alice.page.getByTestId('courtboard-marker-A2')).toHaveCount(0)
  } finally {
    if (firstSessionId) await cancelSession(alice.page, firstSessionId)
    if (secondSessionId) await cancelSession(alice.page, secondSessionId)
  }
})

async function createSession(page: Page, title: string): Promise<URL> {
  await page.goto('/rallies')
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('button', { name: 'Fill sample session' }).click()
  await page.getByPlaceholder('Sunday doubles & rallies').fill(title)
  await page.getByRole('button', { name: 'Publish session' }).click()
  await expect(page.getByRole('heading', { name: title }).last()).toBeVisible()
  return new URL(page.url())
}

async function addMarkerFromSocket(page: Page, socketUrl: string | null, label: string): Promise<void> {
  const added = await page.evaluate(async ({ sourceUrl, markerLabel }) => {
    if (!sourceUrl) throw new Error('The active Canvas room URL was not captured.')
    const sdkUrl = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
    const sdk = await import(sdkUrl)
    const token = await sdk.getAuthToken()
    if (!token) throw new Error('The test player did not have an auth token.')
    const url = new URL(sourceUrl)
    url.searchParams.set('token', token)
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Canvas socket did not open.')), 5000)
      socket.addEventListener('open', () => {
        window.clearTimeout(timeout)
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => {
        window.clearTimeout(timeout)
        reject(new Error('Canvas socket was rejected.'))
      }, { once: true })
    })
    const shape = {
      type: 'rally-player',
      x: 250,
      y: 180,
      width: 72,
      height: 72,
      props: { label: markerLabel },
    }
    return new Promise<boolean>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Canvas did not confirm the marker add.')), 5000)
      socket.addEventListener('message', (event) => {
        const response = JSON.parse(event.data)
        if (response.type === 'core.error') {
          window.clearTimeout(timeout)
          reject(new Error(response.payload?.error ?? 'Canvas marker add failed.'))
          return
        }
        if (response.type === 'canvas.add' && response.payload?.shape?.props?.label === markerLabel) {
          window.clearTimeout(timeout)
          socket.close()
          resolve(true)
        }
      })
      socket.send(sdk.encode(sdk.clientBuild.canvasAdd(shape)))
    })
  }, { sourceUrl: socketUrl, markerLabel: label })
  expect(added).toBe(true)
}

async function cancelSession(page: Page, sessionId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const sdkUrl = new URL('/node_modules/.vite/deps/deepspace.js', location.origin).href
    const sdk = await import(sdkUrl)
    const token = await sdk.getAuthToken()
    if (!token) throw new Error('The session host did not have an auth token.')
    const response = await fetch('/api/actions/rallyCommand', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'cancel', sessionId: id }),
    })
    return { status: response.status, result: await response.json() }
  }, sessionId)
  expect(result.status).toBe(200)
  expect(result.result).toMatchObject({ success: true })
}
