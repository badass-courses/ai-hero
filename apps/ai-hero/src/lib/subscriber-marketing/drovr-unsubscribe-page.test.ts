import { describe, expect, it, vi } from 'vitest'

import {
	courseDisplayName,
	isPlausibleUnsubscribeToken,
	readUnsubscribeState,
	resolveDrovrApiBaseUrl,
	submitUnsubscribeChoice,
	unsubscribePageView,
	type DrovrUnsubscribeState,
	type UnsubscribeLookup,
} from './drovr-unsubscribe-page'

const token = 'v1.eyJ0Ijoib3JnLWFpaGVybyJ9.c2lnbmF0dXJl'
const baseUrl = 'https://drovr.test'

const state = (
	overrides: Partial<DrovrUnsubscribeState> = {},
): DrovrUnsubscribeState => ({
	email: 'j***@g***.com',
	tenantId: 'org-aihero',
	course: { journeyId: 'value-path-skills-course', subscribed: true },
	all: { subscribed: true },
	choices: ['course', 'all'],
	...overrides,
})

const json = (status: number, body: unknown) =>
	vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			}),
	)

describe('drovr unsubscribe client', () => {
	it('reads state with GET /unsubscribe/state?t= and never sends a secret', async () => {
		const fetch = json(200, state())
		const result = await readUnsubscribeState(token, { baseUrl, fetch })

		expect(result).toEqual({ status: 'ok', state: state() })
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(`${baseUrl}/unsubscribe/state?t=${token}`)
		expect(init.method).toBe('GET')
		expect(init.headers).not.toHaveProperty('authorization')
	})

	it('posts { token, choice } to POST /unsubscribe and returns the new state', async () => {
		const after = state({ course: { journeyId: 'value-path-skills-course', subscribed: false } })
		const fetch = json(200, after)
		const result = await submitUnsubscribeChoice(token, 'course', {
			baseUrl,
			fetch,
		})

		expect(result).toEqual({ status: 'ok', state: after })
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(`${baseUrl}/unsubscribe`)
		expect(init.method).toBe('POST')
		expect(JSON.parse(String(init.body))).toEqual({ token, choice: 'course' })
	})

	it('maps drovr 400 to invalid-token and refuses a malformed token without a call', async () => {
		const refused = json(400, {
			type: 'invalid-unsubscribe-token',
			status: 400,
		})
		expect(await readUnsubscribeState(token, { baseUrl, fetch: refused })).toEqual({
			status: 'invalid-token',
		})

		const untouched = json(200, state())
		for (const bad of [undefined, '', 'nope', 'v2.a.b', `v1.${'a'.repeat(3000)}.b`]) {
			expect(
				await readUnsubscribeState(bad, { baseUrl, fetch: untouched }),
			).toEqual({ status: 'invalid-token' })
		}
		expect(untouched).not.toHaveBeenCalled()
	})

	it('reports unavailable for 5xx, a bad reply, an unreachable drovr, or no base URL', async () => {
		expect(
			await readUnsubscribeState(token, { baseUrl, fetch: json(503, {}) }),
		).toEqual({ status: 'unavailable', reason: 'drovr-503' })
		expect(
			await readUnsubscribeState(token, {
				baseUrl,
				fetch: json(200, { email: 'x' }),
			}),
		).toEqual({ status: 'unavailable', reason: 'drovr-bad-reply' })
		expect(
			await readUnsubscribeState(token, {
				baseUrl,
				fetch: async () => {
					throw new TypeError('fetch failed')
				},
			}),
		).toEqual({ status: 'unavailable', reason: 'drovr-unreachable' })
		expect(
			await readUnsubscribeState(token, { baseUrl: undefined }),
		).toEqual({ status: 'unavailable', reason: 'drovr-api-not-configured' })
	})

	it('accepts only the v1 token shape', () => {
		expect(isPlausibleUnsubscribeToken(token)).toBe(true)
		expect(isPlausibleUnsubscribeToken('v1.a.b c')).toBe(false)
	})

	it('resolves the API base from DROVR_API_BASE_URL, else the ingest origin', () => {
		expect(
			resolveDrovrApiBaseUrl({
				DROVR_API_BASE_URL: 'https://api.drovr.sh/',
				DROVR_SHADOW_INGEST_URL: 'https://other.test/events',
			}),
		).toBe('https://api.drovr.sh')
		expect(
			resolveDrovrApiBaseUrl({
				DROVR_SHADOW_INGEST_URL: 'https://drovr-api.example.test/events',
			}),
		).toBe('https://drovr-api.example.test')
		expect(resolveDrovrApiBaseUrl({})).toBeUndefined()
	})

	it('names known courses and falls back to "this course"', () => {
		expect(courseDisplayName(state().course)).toBe('the Skills course')
		expect(
			courseDisplayName({
				journeyId: 'value-path-skills-course',
				subscribed: true,
				displayName: 'the Agents course',
			}),
		).toBe('the Agents course')
		expect(
			courseDisplayName({ journeyId: 'unknown', subscribed: true }),
		).toBe('this course')
	})
})

describe('unsubscribePageView', () => {
	const ok = (s: DrovrUnsubscribeState): UnsubscribeLookup => ({
		status: 'ok',
		state: s,
	})

	it('offers both choices, course first by default', () => {
		expect(unsubscribePageView(ok(state()))).toMatchObject({
			kind: 'choose',
			email: 'j***@g***.com',
			courseName: 'the Skills course',
			options: ['course', 'all'],
			justUpdated: false,
		})
	})

	it('makes the footer link’s preselected choice the primary and keeps the other', () => {
		expect(unsubscribePageView(ok(state()), { choice: 'all' })).toMatchObject({
			options: ['all', 'course'],
		})
		expect(
			unsubscribePageView(ok(state()), { choice: 'course' }),
		).toMatchObject({ options: ['course', 'all'] })
	})

	it('confirms a course unsubscribe and still offers all', () => {
		const after = state({
			course: { journeyId: 'value-path-skills-course', subscribed: false },
		})
		expect(unsubscribePageView(ok(after), { updated: 'course' })).toMatchObject({
			kind: 'choose',
			options: ['all'],
			courseUnsubscribed: true,
			justUpdated: true,
		})
		expect(unsubscribePageView(ok(after))).toMatchObject({
			courseUnsubscribed: true,
			justUpdated: false,
		})
	})

	it('shows already-unsubscribed-from-all with no buttons', () => {
		const off = state({
			course: { journeyId: 'value-path-skills-course', subscribed: false },
			all: { subscribed: false },
		})
		expect(unsubscribePageView(ok(off), { updated: 'all' })).toEqual({
			kind: 'all-unsubscribed',
			email: 'j***@g***.com',
			justUpdated: true,
		})
	})

	it('maps invalid and unavailable lookups, and flags a failed submit', () => {
		expect(unsubscribePageView({ status: 'invalid-token' })).toEqual({
			kind: 'invalid',
		})
		expect(
			unsubscribePageView({ status: 'unavailable', reason: 'drovr-503' }),
		).toEqual({ kind: 'unavailable' })
		expect(
			unsubscribePageView(ok(state()), { submitFailed: true }),
		).toMatchObject({ submitFailed: true })
	})
})
