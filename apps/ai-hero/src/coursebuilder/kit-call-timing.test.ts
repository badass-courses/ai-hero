import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { kitCallPath, withKitCallTiming } from './kit-call-timing'

let server: Server
let origin: string

beforeAll(async () => {
	server = createServer((request, response) => {
		const delay = request.url?.includes('/slow') ? 40 : 0
		setTimeout(() => {
			response.writeHead(request.url?.includes('/missing') ? 404 : 200, {
				'content-type': 'application/json',
			})
			response.end('{"ok":true}')
		}, delay)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
})

const isTestKit = (value: string) => value === origin

describe('per-call Kit timing', () => {
	it('records each Kit call in order with method, a scrubbed path, status, and time', async () => {
		const timed = await withKitCallTiming(
			async () => {
				await fetch(
					`${origin}/v3/sequences/2757205/subscribe?api_key=secret-key`,
					{ method: 'POST', body: '{}' },
				).then((response) => response.json())
				await fetch(`${origin}/v3/subscribers/991/slow?api_secret=s3cret`).then(
					(response) => response.json(),
				)
				await fetch(`${origin}/v3/missing`).then((response) => response.text())
				return 'done'
			},
			{ isKitOrigin: isTestKit },
		)
		expect(timed.value).toBe('done')
		expect(
			timed.calls.map(({ method, path, status }) => ({ method, path, status })),
		).toEqual([
			{ method: 'POST', path: '/v3/sequences/:id/subscribe', status: 200 },
			{ method: 'GET', path: '/v3/subscribers/:id/slow', status: 200 },
			{ method: 'GET', path: '/v3/missing', status: 404 },
		])
		expect(timed.calls[1]!.ms).toBeGreaterThanOrEqual(30)
		expect(timed.durationMs).toBeGreaterThanOrEqual(timed.calls[1]!.ms)
		expect(JSON.stringify(timed.calls)).not.toMatch(/secret|s3cret|api_/)
	})

	it('records nothing outside a timed scope and keeps concurrent scopes apart', async () => {
		await fetch(`${origin}/v3/untimed`).then((response) => response.text())
		const [a, b] = await Promise.all([
			withKitCallTiming(
				() => fetch(`${origin}/v3/a/slow`).then((response) => response.text()),
				{ isKitOrigin: isTestKit },
			),
			withKitCallTiming(
				() => fetch(`${origin}/v3/b`).then((response) => response.text()),
				{ isKitOrigin: isTestKit },
			),
		])
		expect(a.calls.map((call) => call.path)).toEqual(['/v3/a/slow'])
		expect(b.calls.map((call) => call.path)).toEqual(['/v3/b'])
	})

	it('ignores calls to hosts that are not Kit', async () => {
		const timed = await withKitCallTiming(
			() => fetch(`${origin}/v3/elsewhere`).then((response) => response.text()),
			{ isKitOrigin: () => false },
		)
		expect(timed.calls).toEqual([])
	})

	it('keeps the error and the calls when the timed work throws', async () => {
		const timed = await withKitCallTiming(
			async () => {
				await fetch(`${origin}/v3/tags`).then((response) => response.text())
				throw new Error('kit refused')
			},
			{ isKitOrigin: isTestKit },
		)
		expect(timed.error).toBeInstanceOf(Error)
		expect(timed.calls.map((call) => call.path)).toEqual(['/v3/tags'])
	})

	it('never logs an address or a query', () => {
		expect(kitCallPath('/v3/subscribers?email_address=a%40b.co')).toBe(
			'/v3/subscribers',
		)
		expect(kitCallPath('/v4/subscribers/learner@example.com/tags')).toBe(
			'/v4/subscribers/:redacted/tags',
		)
		expect(kitCallPath('/v4/subscribers/learner%40example.com')).toBe(
			'/v4/subscribers/:redacted',
		)
		expect(kitCallPath('/v3/forms/9376133/subscribe')).toBe(
			'/v3/forms/:id/subscribe',
		)
	})
})
