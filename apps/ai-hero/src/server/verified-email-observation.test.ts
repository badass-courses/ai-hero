import { Auth } from '@auth/core'
import type { Adapter, AdapterUser, AdapterSession } from '@auth/core/adapters'
import Postmark from '@auth/core/providers/postmark'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createMagicLinkGetHandler,
	createMagicLinkConfirmHandler,
} from './magic-link-confirmation'
import {
	createOAuthContainmentAdapter,
	runWithOAuthContainmentRequest,
} from './oauth-link-containment'
import {
	createVerifiedEmailObservation,
	type EmailLoginCapture,
} from './verified-email-observation'

const secret = 'synthetic-auth-secret-not-production'
const email = 'learner@example.test',
	token = 'synthetic-email-token'
const at = '2026-09-08T04:30:00.123Z'
const callbackUrl = `https://auth.example.test/api/auth/callback/postmark?token=${token}&email=${email}`
function fixture(
	options: {
		enabled?: boolean
		newUser?: boolean
		sameUser?: boolean
		expired?: boolean
		missing?: boolean
		identifier?: string
		authorize?: boolean
		writerFails?: boolean
		diagnosticFails?: boolean
		priorFails?: boolean
		roundedRevision?: boolean
		wrongSession?: boolean
		userId?: string
		email?: string
		observer?: ReturnType<typeof createVerifiedEmailObservation>
	} = {},
) {
	const order: string[] = [],
		captures: EmailLoginCapture[] = [],
		codes: string[] = []
	const userId = options.userId ?? 'user-fixture'
	const address = options.email ?? email
	let user: AdapterUser = {
		id: userId,
		email: address,
		emailVerified: null,
		roles: [],
		entitlements: [],
	}
	let created: AdapterSession | null = null
	const observer =
		options.observer ??
		createVerifiedEmailObservation(
			options.enabled === false
				? { enabled: false }
				: {
						enabled: true,
						providerId: 'postmark',
						now: () => new Date(),
						writer: async (capture) => {
							order.push('observe')
							if (options.writerFails)
								throw new Error('sensitive SQL email token must not escape')
							captures.push(capture)
							return { type: 'Recorded' }
						},
						diagnostic: (code) => {
							codes.push(code)
							if (options.diagnosticFails) throw new Error('diagnostic down')
						},
					},
		)
	const adapter: Adapter = {
		createUser: async (data) => {
			order.push('createUser')
			user = { ...data, id: userId, roles: [], entitlements: [] }
			return { ...user }
		},
		getUser: async () => user,
		getUserByEmail: async () => (options.newUser ? null : user),
		getUserByAccount: async () => null,
		updateUser: async (data) => {
			order.push('updateUser')
			user = { ...user, ...data }
			if (options.roundedRevision)
				user.emailVerified = new Date(
					Math.floor(user.emailVerified!.getTime() / 1000) * 1000,
				)
			return { ...user }
		},
		deleteUser: async () => undefined,
		linkAccount: async () => undefined,
		unlinkAccount: async () => undefined,
		createSession: async (data) => {
			order.push('createSession')
			created = {
				...data,
				userId: options.wrongSession ? 'foreign-user' : data.userId,
				expires: new Date(Math.floor(data.expires.getTime() / 1000) * 1000),
			}
			return { ...created }
		},
		getSessionAndUser: async () =>
			options.sameUser
				? {
						user,
						session: {
							sessionToken: 'old-session',
							userId: user.id,
							expires: new Date(Date.now() + 60000),
						},
					}
				: null,
		updateSession: async () => null,
		deleteSession: async () => undefined,
		createVerificationToken: async (data) => data,
		useVerificationToken: async (data) => {
			order.push('token')
			return options.missing
				? null
				: {
						...data,
						identifier: options.identifier ?? address,
						expires: new Date(Date.now() + (options.expired ? -1 : 60000)),
					}
		},
	}
	const auth = (request: Request, scope = true) => {
		const operation = () =>
			runWithOAuthContainmentRequest(request, () =>
				Auth(request, {
					adapter: observer.wrapAdapter(createOAuthContainmentAdapter(adapter)),
					secret,
					trustHost: true,
					basePath: '/api/auth',
					providers: [
						Postmark({
							apiKey: 'synthetic',
							from: 'fixture@example.test',
							sendVerificationRequest: async () => {
								order.push('send')
							},
						}),
					],
					callbacks: { signIn: async () => options.authorize !== false },
					events: {
						signIn: observer.wrapSignIn(async () => {
							order.push('prior-signIn')
							if (options.priorFails)
								throw new Error('prior side effect failed')
						}),
					},
					logger: {
						error: () => undefined,
						warn: () => undefined,
						debug: () => undefined,
					},
				}),
			)
		return scope ? observer.run(request, operation) : operation()
	}
	const run = (scope = true) => {
		const hash = createHash('sha256')
			.update(token + secret)
			.digest('hex')
		const url = new URL(callbackUrl)
		url.searchParams.set('email', address)
		const request = new Request(url, {
			method: 'POST',
			headers: options.sameUser
				? { cookie: '__Secure-authjs.session-token=old-session' }
				: {},
		})
		return { response: auth(request, scope), hash }
	}
	return {
		run,
		auth,
		observer,
		adapter,
		order,
		captures,
		codes,
		get user() {
			return user
		},
		get created() {
			return created
		},
	}
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(at))
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('External network forbidden')
		}),
	)
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})
describe('actual installed Auth email callback observation', () => {
	it.each([{}, { newUser: true }, { sameUser: true }])(
		'correlates actual callback returns and session cookie %j',
		async (options) => {
			const f = fixture(options),
				run = f.run(),
				response = await run.response
			expect(response.status).toBe(302)
			expect(response.headers.get('set-cookie')).toContain(
				f.created!.sessionToken,
			)
			expect(f.order).toEqual([
				'token',
				options.newUser ? 'createUser' : 'updateUser',
				'createSession',
				'prior-signIn',
				'observe',
			])
			expect(f.captures).toHaveLength(1)
			expect(f.captures[0]).toMatchObject({
				userId: 'user-fixture',
				email,
				verifiedAt: at,
				acceptedToken: run.hash,
				sessionToken: f.created!.sessionToken,
			})
			expect(f.captures[0]!.sessionToken).not.toBe('old-session')
			expect(fetch).not.toHaveBeenCalled()
		},
	)
	it.each([
		{ enabled: false },
		{ expired: true },
		{ missing: true },
		{ identifier: 'other@example.test' },
		{ authorize: false },
	])('does not observe unproved callback %j', async (options) => {
		const f = fixture(options)
		await f.run().response
		expect(f.captures).toEqual([])
		expect(f.order).not.toContain('observe')
	})
	it('no request scope captures nothing', async () => {
		const f = fixture()
		await f.run(false).response
		expect(f.captures).toEqual([])
	})
	it.each([
		{ writerFails: true },
		{ diagnosticFails: true },
		{ writerFails: true, diagnosticFails: true },
	])('observer failures preserve successful cookie %j', async (options) => {
		const f = fixture(options),
			response = await f.run().response
		expect(response.status).toBe(302)
		expect(response.headers.get('set-cookie')).toContain(
			f.created!.sessionToken,
		)
		expect(f.codes).toEqual([
			options.writerFails ? 'observation-unavailable' : 'observation-recorded',
		])
	})
	it('does not observe after prior signIn side effects throw', async () => {
		const f = fixture({ priorFails: true })
		await f.run().response
		expect(f.order).not.toContain('observe')
	})
	it.each([{ roundedRevision: true }, { wrongSession: true }])(
		'rejects inconsistent adapter return without changing auth success %j',
		async (options) => {
			const f = fixture(options),
				response = await f.run().response
			expect(response.headers.get('set-cookie')).toContain(
				f.created!.sessionToken,
			)
			expect(f.captures).toEqual([])
			expect(f.codes).toEqual(['capture-invalid'])
		},
	)
	it.each([
		{ raw: 'ΟΣ@example.test', admitted: true },
		{ raw: 'İ@example.test', admitted: true },
		{ raw: 'a!b/x@example.test', admitted: true },
		{ raw: '"quoted"@example.test', admitted: true },
		{ raw: '𐐀'.repeat(255), admitted: true },
		{ raw: 'İ'.repeat(255), admitted: true },
		{ raw: '𐐀'.repeat(256), admitted: false },
		{ raw: 'K@example.test', admitted: true },
	])(
		'SDK auth survives structural evidence bounds for $raw',
		async ({ raw, admitted }) => {
			const f = fixture({ email: raw }),
				response = await f.run().response
			expect(response.status).toBe(302)
			expect(response.headers.get('set-cookie')).toContain(
				f.created!.sessionToken,
			)
			expect(f.captures).toHaveLength(admitted ? 1 : 0)
			if (admitted) expect(f.captures[0]!.email).toBe(raw.trim().toLowerCase())
			else expect(f.codes).toEqual(['capture-invalid'])
			expect(fetch).not.toHaveBeenCalled()
		},
	)
	it('one shared observer isolates parallel actual SDK invocations', async () => {
		const captures: EmailLoginCapture[] = []
		const observer = createVerifiedEmailObservation({
			enabled: true,
			providerId: 'postmark',
			now: () => new Date(),
			writer: async (capture) => {
				captures.push(capture)
				return { type: 'Recorded' }
			},
		})
		const fixtures = Array.from({ length: 12 }, (_, i) =>
			fixture({ observer, userId: `parallel-${i}` }),
		)
		const responses = await Promise.all(fixtures.map((f) => f.run().response))
		expect(captures).toHaveLength(12)
		for (let i = 0; i < fixtures.length; i++) {
			const f = fixtures[i]!
			expect(captures.find((c) => c.userId === f.user.id)?.sessionToken).toBe(
				f.created!.sessionToken,
			)
			expect(responses[i]!.headers.get('set-cookie')).toContain(
				f.created!.sessionToken,
			)
		}
	})
	it('confirmation GET has no observation; generated callback POST is scoped and observed', async () => {
		const f = fixture()
		const get = createMagicLinkGetHandler(
			(request: Request) => f.auth(request),
			{ secret },
		)
		const response = await get(new Request(callbackUrl))
		expect(f.order).toEqual([])
		expect(f.captures).toEqual([])
		const cookie = response.headers.get('set-cookie')!.split(';')[0]!
		const confirm = createMagicLinkConfirmHandler(
			(request) => f.auth(request),
			{ secret },
		)
		const loggedIn = await confirm(
			new Request('https://auth.example.test/api/auth/magic-link/confirm', {
				method: 'POST',
				headers: { cookie },
			}),
		)
		expect(loggedIn.headers.get('set-cookie')).toContain(
			f.created!.sessionToken,
		)
		expect(f.captures).toHaveLength(1)
	})
	it('actual SDK link-request send phase does not observe or verify a user', async () => {
		const f = fixture()
		const csrf = await f.auth(
			new Request('https://auth.example.test/api/auth/csrf'),
		)
		const { csrfToken } = await csrf.json()
		const cookie = csrf.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ')
		const response = await f.auth(
			new Request('https://auth.example.test/api/auth/signin/postmark', {
				method: 'POST',
				headers: {
					cookie,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ csrfToken, email }),
			}),
		)
		expect(response.status).toBe(302)
		expect(f.order).toContain('send')
		expect(f.order).not.toContain('observe')
		expect(f.user.emailVerified).toBeNull()
		expect(f.created).toBeNull()
		expect(fetch).not.toHaveBeenCalled()
	})
})
describe('request observer adapter and side-effect contracts', () => {
	it('disabled composition preserves exact adapter, operation promise and callback identities', () => {
		const f = fixture({ enabled: false }),
			promise = Promise.resolve('response'),
			callback = vi.fn(async () => {})
		expect(f.observer.wrapAdapter(f.adapter)).toBe(f.adapter)
		expect(f.observer.run(new Request(callbackUrl), () => promise)).toBe(
			promise,
		)
		expect(f.observer.wrapSignIn(callback)).toBe(callback)
	})
	it('preserves bound receiver, actual return identity and original adapter errors', async () => {
		const f = fixture(),
			failure = new Error('underlying auth failed'),
			result = {
				identifier: email,
				token,
				expires: new Date(Date.now() + 60000),
			}
		const adapter = {
			marker: 'receiver',
			async useVerificationToken() {
				expect(this.marker).toBe('receiver')
				return result
			},
			async getUser() {
				expect(this.marker).toBe('receiver')
				throw failure
			},
		}
		const wrapped = f.observer.wrapAdapter(adapter)
		await f.observer.run(new Request(callbackUrl), async () => {
			expect(await wrapped.useVerificationToken()).toBe(result)
			await expect(wrapped.getUser()).rejects.toBe(failure)
		})
	})
	it('prior side-effect errors propagate unchanged before any observer catch', async () => {
		const f = fixture(),
			failure = new Error('existing chain')
		await expect(
			f.observer.run(new Request(callbackUrl), () =>
				f.observer.wrapSignIn(async () => {
					throw failure
				})({
					user: f.user,
					account: {
						type: 'email',
						provider: 'postmark',
						providerAccountId: email,
					},
				}),
			),
		).rejects.toBe(failure)
		expect(f.codes).toEqual([])
		expect(f.captures).toEqual([])
	})
	async function manual(
		f: ReturnType<typeof fixture>,
		mutation: (wrapped: Adapter) => Promise<void>,
		eventType: 'email' | 'oauth' = 'email',
		provider = 'postmark',
		route = callbackUrl,
	) {
		const wrapped = f.observer.wrapAdapter(f.adapter)
		return f.observer.run(new Request(route), async () => {
			await wrapped.useVerificationToken!({ identifier: email, token })
			await wrapped.updateUser!({ id: f.user.id, emailVerified: new Date(at) })
			await wrapped.createSession!({
				userId: f.user.id,
				sessionToken: 'manual-session',
				expires: new Date(Date.now() + 60000),
			})
			await mutation(wrapped)
			await f.observer.wrapSignIn()({
				user: f.user,
				account: { type: eventType, provider, providerAccountId: email },
			})
		})
	}
	it.each(['token', 'user', 'session'] as const)(
		'conflicting repeated %s invalidates evidence',
		async (key) => {
			const f = fixture()
			await manual(f, async (wrapped) => {
				if (key === 'token')
					await wrapped.useVerificationToken!({
						identifier: email,
						token: 'different',
					})
				if (key === 'user')
					await wrapped.updateUser!({
						id: f.user.id,
						emailVerified: new Date('2026-09-08T04:30:00.124Z'),
					})
				if (key === 'session')
					await wrapped.createSession!({
						userId: f.user.id,
						sessionToken: 'different',
						expires: new Date(Date.now() + 60000),
					})
			})
			expect(f.captures).toEqual([])
			expect(f.codes).toEqual(['capture-invalid'])
		},
	)
	it.each([
		{ type: 'oauth' as const, provider: 'postmark' },
		{ type: 'email' as const, provider: 'github' },
	])('does not substitute other signIn kinds %j', async (kind) => {
		const f = fixture()
		await manual(f, async () => {}, kind.type, kind.provider)
		expect(f.captures).toEqual([])
	})
	it('does not collect on an OAuth or link-request route', async () => {
		for (const route of [
			'https://auth.example.test/api/auth/callback/github',
			'https://auth.example.test/api/auth/signin/postmark',
		]) {
			const f = fixture()
			await manual(f, async () => {}, 'email', 'postmark', route)
			expect(f.captures).toEqual([])
		}
	})
	it('production auth is wired through a disabled observer and imports no writer', async () => {
		const source = await fs.readFile(
			new URL('./auth.ts', import.meta.url),
			'utf8',
		)
		expect(source).toContain(
			'createVerifiedEmailObservation({ enabled: false })',
		)
		expect(source).toContain('emailObservation.wrapAdapter(')
		expect(source).toContain('emailObservation.wrapSignIn(')
		expect(source.match(/emailObservation\.run\(request/g)).toHaveLength(2)
		expect(source).not.toContain('createEmailTokenLoginObservationWriter')
	})
})
