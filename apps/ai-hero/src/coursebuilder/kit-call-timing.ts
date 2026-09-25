import { AsyncLocalStorage } from 'node:async_hooks'
import diagnosticsChannel from 'node:diagnostics_channel'

/**
 * Per-call timing for one logical Kit operation. Course Builder's
 * subscribeToList is several sequential Kit calls (subscribe, read back,
 * field checks, field write, read back) with no timing of its own, so a
 * slow operation could not say which call stalled.
 *
 * This listens on undici's diagnostics channels, which Node's fetch
 * publishes for every request; fetch itself is never patched. An
 * AsyncLocalStorage scope ties each call to the operation that made it,
 * so concurrent requests on one instance never mix. Paths lose their
 * query (keys, secrets, addresses) and numeric ids; any segment holding an
 * address is redacted.
 */

export type KitCall = {
	method: string
	path: string
	status?: number
	/** Request start to the end of the response body (or the error). */
	ms: number
	error?: string
}

export type KitCallTiming<T> = {
	value?: T
	error?: unknown
	calls: KitCall[]
	durationMs: number
}

const KIT_ORIGINS = new Set([
	'https://api.convertkit.com',
	'https://api.kit.com',
])

type Scope = { calls: KitCall[]; isKitOrigin: (origin: string) => boolean }
type Pending = { call: KitCall; startedAt: number }

type UndiciRequest = { origin?: unknown; method?: unknown; path?: unknown }

const scope = new AsyncLocalStorage<Scope>()
const pending = new WeakMap<object, Pending>()
let listening = false

function listen() {
	if (listening) return
	listening = true
	diagnosticsChannel.subscribe('undici:request:create', (message) => {
		const { request } = message as { request: UndiciRequest }
		const active = scope.getStore()
		if (!active || !request) return
		const origin = String(request.origin ?? '')
		if (!active.isKitOrigin(origin)) return
		const call: KitCall = {
			method: String(request.method ?? 'GET'),
			path: kitCallPath(String(request.path ?? '')),
			ms: 0,
		}
		active.calls.push(call)
		pending.set(request, { call, startedAt: performance.now() })
	})
	diagnosticsChannel.subscribe('undici:request:headers', (message) => {
		const { request, response } = message as {
			request: object
			response: { statusCode?: number }
		}
		const entry = pending.get(request)
		if (!entry) return
		entry.call.status = response?.statusCode
		entry.call.ms = elapsed(entry.startedAt)
	})
	diagnosticsChannel.subscribe('undici:request:trailers', (message) => {
		const { request } = message as { request: object }
		const entry = pending.get(request)
		if (!entry) return
		entry.call.ms = elapsed(entry.startedAt)
		pending.delete(request)
	})
	diagnosticsChannel.subscribe('undici:request:error', (message) => {
		const { request, error } = message as { request: object; error: unknown }
		const entry = pending.get(request)
		if (!entry) return
		entry.call.ms = elapsed(entry.startedAt)
		entry.call.error = error instanceof Error ? error.name : 'error'
		pending.delete(request)
	})
}

const elapsed = (startedAt: number) => Math.round(performance.now() - startedAt)

/** Run one Kit operation and return what it did, call by call. Never throws. */
export async function withKitCallTiming<T>(
	work: () => Promise<T>,
	options: { isKitOrigin?: (origin: string) => boolean } = {},
): Promise<KitCallTiming<T>> {
	listen()
	const active: Scope = {
		calls: [],
		isKitOrigin: options.isKitOrigin ?? ((origin) => KIT_ORIGINS.has(origin)),
	}
	const startedAt = performance.now()
	return await scope.run(active, async () => {
		try {
			const value = await work()
			return { value, calls: active.calls, durationMs: elapsed(startedAt) }
		} catch (error) {
			return { error, calls: active.calls, durationMs: elapsed(startedAt) }
		}
	})
}

/** A loggable path: no query, numeric ids as :id, addresses redacted. */
export function kitCallPath(path: string): string {
	const [bare] = path.split('?')
	return (bare ?? '')
		.split('/')
		.map((segment) => {
			if (/^\d+$/.test(segment)) return ':id'
			if (segment.includes('@') || /%40/i.test(segment)) return ':redacted'
			return segment
		})
		.join('/')
}
