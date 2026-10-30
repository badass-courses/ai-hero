import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	table: null as unknown as ReturnType<
		typeof import('./test-fakes').makeTokenTable
	>,
	redis: null as unknown as ReturnType<
		typeof import('./test-fakes').makeRedisFake
	>,
	session: vi.fn(),
	logs: [] as unknown[][],
	recordClientName: vi.fn(),
	rateLimit: vi.fn(),
}))

vi.mock('drizzle-orm', async (importOriginal) => ({
	...(await importOriginal<typeof import('drizzle-orm')>()),
	...(await import('./test-fakes')).drizzleFake,
}))
vi.mock('@/db', async () => {
	state.table = (await import('./test-fakes')).makeTokenTable()
	return { db: state.table.db }
})
vi.mock('@/db/schema', async () => (await import('./test-fakes')).schemaFake)
vi.mock('@/server/redis-client', async () => {
	state.redis = (await import('./test-fakes')).makeRedisFake()
	return { redis: state.redis.redis }
})
vi.mock('@/server/auth', () => ({ getServerAuthSession: state.session }))
vi.mock('@/server/logger', () => {
	const capture =
		(level: string) =>
		(...args: unknown[]) =>
			void state.logs.push([level, ...args])
	return {
		log: {
			info: capture('info'),
			warn: capture('warn'),
			error: capture('error'),
		},
	}
})
vi.mock('@/lib/learner-agent/oauth/rate-limit', () => ({
	oauthRateLimit: state.rateLimit,
}))
vi.mock('@/lib/learner-agent/oauth/client-name', () => ({
	recordClientName: state.recordClientName,
	clientNamesFor: async () => new Map(),
}))
vi.mock('@/app/oauth/userinfo/get-user', () => ({ getUser: vi.fn() }))
vi.mock('@/lib/learner-agent/ports', () => ({
	learnerAgentPortsFor: async (_request: Request, learner: unknown) => ({
		learner,
		entitlements: {},
		content: {},
		progress: {},
		search: { search: async () => [] },
		audit: { read: () => undefined },
		rateLimit: { consume: async () => ({ ok: true }) },
		site: {
			baseUrl: BASE,
			connectUrl: `${BASE}/api/learner#sign-in`,
			instructionsUrl: `${BASE}/api/learner`,
			mcpUrl: `${BASE}/mcp`,
		},
	}),
}))

import { POST as mcpPost } from '@/app/mcp/route'
import { POST as decide } from '@/app/oauth/authorize/decision/route'
import { GET as authorize } from '@/app/oauth/authorize/route'
import { POST as register } from '@/app/oauth/register/route'
import { POST as revoke } from '@/app/oauth/revoke/route'
import { POST as token } from '@/app/oauth/token/route'

const BASE = 'http://localhost:3000'
const REDIRECT = 'http://localhost:7777/callback'
const EMAIL = 'learner@example.test'

const signedIn = (id: string | null) =>
	state.session.mockResolvedValue({
		session: id ? { user: { id, email: EMAIL } } : null,
		ability: {},
	})

function pkce() {
	const verifier = randomBytes(32).toString('base64url')
	const challenge = createHash('sha256').update(verifier).digest('base64url')
	return { verifier, challenge }
}

async function registerClient(name = 'Claude Code', uris = [REDIRECT]) {
	const response = await register(
		new Request(`${BASE}/oauth/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: name,
				redirect_uris: uris,
				grant_types: ['authorization_code', 'refresh_token'],
				token_endpoint_auth_method: 'none',
			}),
		}),
	)
	expect(response.status).toBe(201)
	return (await response.json()).client_id as string
}

function authorizeUrl(params: Record<string, string>) {
	const url = new URL(`${BASE}/oauth/authorize`)
	for (const [key, value] of Object.entries(params))
		url.searchParams.set(key, value)
	return url.toString()
}

const location = (response: Response) =>
	new URL(response.headers.get('location') as string)

async function startAuthorize(
	clientId: string,
	challenge: string,
	extra: Record<string, string> = {},
) {
	return authorize(
		new Request(
			authorizeUrl({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state: 'state-123',
				scope: 'learner:read',
				resource: `${BASE}/mcp`,
				...extra,
			}),
		),
	)
}

async function decideWith(
	ticket: string,
	decision: 'approve' | 'deny',
	origin = BASE,
) {
	const body = new FormData()
	body.set('ticket', ticket)
	body.set('decision', decision)
	return decide(
		new Request(`${BASE}/oauth/authorize/decision`, {
			method: 'POST',
			headers: { Origin: origin },
			body,
		}),
	)
}

async function approvedCode(clientId: string, challenge: string) {
	const started = await startAuthorize(clientId, challenge)
	expect(started.status).toBe(302)
	const ticket = location(started).searchParams.get('ticket') as string
	const decided = await decideWith(ticket, 'approve')
	expect(decided.status).toBe(303)
	return location(decided).searchParams.get('code') as string
}

async function exchange(fields: Record<string, string>) {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		...fields,
	})
	return token(
		new Request(`${BASE}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
		}),
	)
}

const mcpCall = (accessToken: string | null, body: unknown) =>
	mcpPost(
		new Request(`${BASE}/mcp`, {
			method: 'POST',
			headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
			body: JSON.stringify(body),
		}),
	)

beforeEach(() => {
	state.table.rows.length = 0
	state.redis.store.clear()
	state.logs.length = 0
	state.recordClientName.mockReset()
	state.rateLimit.mockReset().mockResolvedValue(true)
	signedIn('u1')
})

afterEach(() => {
	vi.useRealTimers()
})

describe('learner OAuth: authorization code with PKCE', () => {
	it('signs a learner in end to end, names the client, and the token works on /mcp', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()

		const started = await startAuthorize(clientId, challenge)
		const consent = location(started)
		expect(consent.pathname).toBe('/oauth/authorize/consent')

		const decided = await decideWith(
			consent.searchParams.get('ticket') as string,
			'approve',
		)
		const back = location(decided)
		expect(back.origin + back.pathname).toBe(REDIRECT)
		expect(back.searchParams.get('state')).toBe('state-123')
		expect(back.searchParams.get('iss')).toBe(`${BASE}/oauth`)

		const before = Date.now()
		const response = await exchange({
			code: back.searchParams.get('code') as string,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${BASE}/mcp`,
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const issued = await response.json()
		expect(issued).toMatchObject({
			token_type: 'Bearer',
			scope: 'learner:read',
			expires_in: 90 * 24 * 3600,
		})
		expect(issued).not.toHaveProperty('refresh_token')

		const row = state.table.rows[0] as Record<string, unknown>
		expect(row).toMatchObject({
			token: issued.access_token,
			userId: 'u1',
			scope: 'learner:read',
			revokedAt: null,
		})
		const ttl = (row.expiresAt as Date).getTime() - before
		expect(ttl).toBeGreaterThan(89 * 24 * 3600_000)
		expect(ttl).toBeLessThanOrEqual(90 * 24 * 3600_000 + 1000)
		expect(state.recordClientName).toHaveBeenCalledWith(
			issued.access_token,
			'Claude Code',
		)

		const listed = await mcpCall(issued.access_token, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		expect(listed.status).toBe(200)
	})

	it('sends a signed-out learner to log in, then back to the same authorize URL', async () => {
		signedIn(null)
		const clientId = await registerClient()
		const { challenge } = pkce()
		const response = await startAuthorize(clientId, challenge)
		expect(response.status).toBe(302)
		const login = location(response)
		expect(login.origin + login.pathname).toBe(`${BASE}/login`)
		const callback = login.searchParams.get('callbackUrl') as string
		expect(callback.startsWith('/oauth/authorize?')).toBe(true)
		expect(new URLSearchParams(callback.split('?')[1]).get('client_id')).toBe(
			clientId,
		)
	})

	it('refuses a PKCE mismatch without burning the code', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const fields = { code, client_id: clientId, redirect_uri: REDIRECT }

		const wrong = await exchange({ ...fields, code_verifier: pkce().verifier })
		expect(wrong.status).toBe(400)
		expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' })
		expect(state.table.rows).toHaveLength(0)

		const right = await exchange({ ...fields, code_verifier: verifier })
		expect(right.status).toBe(200)
	})

	it('refuses a reused code and revokes the token the first use minted', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const fields = {
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
		}

		const first = await exchange(fields)
		expect(first.status).toBe(200)
		const { access_token } = await first.json()

		const replay = await exchange(fields)
		expect(replay.status).toBe(400)
		expect(await replay.json()).toMatchObject({ error: 'invalid_grant' })
		expect(state.table.rows).toHaveLength(1)
		expect(state.table.rows[0]?.revokedAt).toBeInstanceOf(Date)

		const call = await mcpCall(access_token, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		expect(call.status).toBe(401)
	})

	it('refuses a redirect_uri at the token endpoint that differs from the request', async () => {
		const clientId = await registerClient('Claude Code', [
			REDIRECT,
			'https://app.example.test/callback',
		])
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const response = await exchange({
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: 'https://app.example.test/callback',
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
	})

	it('refuses a code presented by a different client', async () => {
		const clientId = await registerClient()
		const otherClient = await registerClient('Other')
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const response = await exchange({
			code,
			code_verifier: verifier,
			client_id: otherClient,
			redirect_uri: REDIRECT,
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
	})

	it('refuses a code after its 60 seconds', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		vi.useFakeTimers({ now: Date.now() + 61_000 })
		const response = await exchange({
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
	})

	it('refuses the wrong resource at authorize and at the token endpoint', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()

		const atAuthorize = await startAuthorize(clientId, challenge, {
			resource: 'https://evil.example.test/mcp',
		})
		const back = location(atAuthorize)
		expect(back.origin + back.pathname).toBe(REDIRECT)
		expect(back.searchParams.get('error')).toBe('invalid_target')
		expect(back.searchParams.get('state')).toBe('state-123')

		const code = await approvedCode(clientId, challenge)
		const atToken = await exchange({
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${BASE}/api`,
		})
		expect(atToken.status).toBe(400)
		expect(await atToken.json()).toMatchObject({ error: 'invalid_target' })
	})

	it.each([
		[
			'a wider scope',
			{ scope: 'learner:read learner:progress' },
			'invalid_scope',
		],
		['an unscoped admin ask', { scope: 'content:read' }, 'invalid_scope'],
		[
			'a plain challenge',
			{ code_challenge_method: 'plain' },
			'invalid_request',
		],
		['no challenge', { code_challenge: '' }, 'invalid_request'],
		[
			'the implicit flow',
			{ response_type: 'token' },
			'unsupported_response_type',
		],
	])(
		'redirects %s back with an error and issues nothing',
		async (_label, extra, error) => {
			const clientId = await registerClient()
			const response = await startAuthorize(clientId, pkce().challenge, extra)
			const back = location(response)
			expect(back.origin + back.pathname).toBe(REDIRECT)
			expect(back.searchParams.get('error')).toBe(error)
			expect(back.searchParams.get('code')).toBeNull()
		},
	)

	it('treats a missing scope as learner:read, never unscoped', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const started = await authorize(
			new Request(
				authorizeUrl({
					response_type: 'code',
					client_id: clientId,
					redirect_uri: REDIRECT,
					code_challenge: challenge,
					code_challenge_method: 'S256',
				}),
			),
		)
		const ticket = location(started).searchParams.get('ticket') as string
		const code = location(await decideWith(ticket, 'approve')).searchParams.get(
			'code',
		) as string
		const response = await exchange({
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
		})
		expect((await response.json()).scope).toBe('learner:read')
		expect(state.table.rows[0]?.scope).toBe('learner:read')
	})

	it('never redirects to an unregistered redirect_uri or for an unknown client', async () => {
		const clientId = await registerClient()
		const { challenge } = pkce()

		const mismatch = await startAuthorize(clientId, challenge, {
			redirect_uri: 'https://evil.example.test/steal',
		})
		expect(location(mismatch).pathname).toBe('/oauth/authorize/consent')
		expect(location(mismatch).searchParams.get('error')).toBe(
			'invalid_redirect_uri',
		)

		const unknown = await startAuthorize('not-a-client', challenge)
		expect(location(unknown).pathname).toBe('/oauth/authorize/consent')
		expect(location(unknown).searchParams.get('error')).toBe('invalid_client')

		const tampered = await startAuthorize(
			`${clientId.slice(0, -4)}AAAA`,
			challenge,
		)
		expect(location(tampered).searchParams.get('error')).toBe('invalid_client')
	})

	it('accepts a loopback redirect on another port, as native clients bind one', async () => {
		const clientId = await registerClient('CLI', ['http://127.0.0.1/callback'])
		const response = await startAuthorize(clientId, pkce().challenge, {
			redirect_uri: 'http://127.0.0.1:53111/callback',
		})
		expect(location(response).searchParams.get('ticket')).toBeTruthy()
	})

	it('sends access_denied with the state when the learner denies', async () => {
		const clientId = await registerClient()
		const started = await startAuthorize(clientId, pkce().challenge)
		const ticket = location(started).searchParams.get('ticket') as string
		const back = location(await decideWith(ticket, 'deny'))
		expect(back.searchParams.get('error')).toBe('access_denied')
		expect(back.searchParams.get('state')).toBe('state-123')
		expect(back.searchParams.get('code')).toBeNull()
	})

	it('refuses a decision posted from another site, or by another account', async () => {
		const clientId = await registerClient()
		const started = await startAuthorize(clientId, pkce().challenge)
		const ticket = location(started).searchParams.get('ticket') as string

		expect(
			(await decideWith(ticket, 'approve', 'https://evil.example.test')).status,
		).toBe(403)

		signedIn('u2')
		const other = await decideWith(ticket, 'approve')
		expect(location(other).searchParams.get('error')).toBe('wrong_account')
		expect(location(other).searchParams.get('code')).toBeNull()
	})

	it('answers 429 when the token endpoint is over budget', async () => {
		state.rateLimit.mockResolvedValue(false)
		const response = await exchange({ code: 'x' })
		expect(response.status).toBe(429)
	})

	it('revokes a learner token through /oauth/revoke, and /mcp then answers 401', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const { access_token } = await (
			await exchange({
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: REDIRECT,
			})
		).json()

		const revoked = await revoke(
			new Request(`${BASE}/oauth/revoke`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token: access_token, client_id: clientId }),
			}),
		)
		expect(revoked.status).toBe(200)

		const call = await mcpCall(access_token, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'search_course', arguments: { query: 'agents' } },
		})
		expect(call.status).toBe(401)
		expect(call.headers.get('www-authenticate')).toContain(
			'error="invalid_token"',
		)
	})

	it('only revokes learner:read rows, and answers 200 for anything else', async () => {
		state.table.rows.push(
			{ token: 'cli-token', userId: 'u1', scope: null, revokedAt: null },
			{
				token: 'analytics-token',
				userId: 'u1',
				scope: 'analytics:read',
				revokedAt: null,
			},
		)
		for (const value of ['cli-token', 'analytics-token', 'unknown-token']) {
			const response = await revoke(
				new Request(`${BASE}/oauth/revoke`, {
					method: 'POST',
					body: new URLSearchParams({ token: value }),
				}),
			)
			expect(response.status).toBe(200)
		}
		expect(state.table.rows.every((row) => row.revokedAt === null)).toBe(true)
	})

	it('never logs emails, codes or tokens', async () => {
		const clientId = await registerClient()
		const { verifier, challenge } = pkce()
		const code = await approvedCode(clientId, challenge)
		const { access_token } = await (
			await exchange({
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: REDIRECT,
			})
		).json()
		await exchange({
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
		})
		await mcpCall('unknown-token', { jsonrpc: '2.0', id: 1, method: 'ping' })

		const logged = JSON.stringify(state.logs)
		expect(state.logs.length).toBeGreaterThan(0)
		for (const secret of [EMAIL, code, access_token, verifier, clientId])
			expect(logged).not.toContain(secret)
		expect(logged).toContain('token_issued')
		expect(logged).toContain('localhost:7777')
	})
})

describe('device flow and register stay as they were', () => {
	it('gives a request without RFC 7591 metadata the demo response', async () => {
		for (const init of [
			{ method: 'POST' },
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ client_name: 'cli' }),
			},
		]) {
			const response = await register(
				new Request(`${BASE}/oauth/register`, init),
			)
			expect(response.status).toBe(201)
			const body = await response.json()
			expect(body.client_id).toMatch(/^[A-P]{6}$/)
			expect(body.client_secret).toMatch(/^[A-P]{6}$/)
		}
		expect(state.rateLimit).not.toHaveBeenCalled()
	})

	it('registers a public client with no secret, and refuses a bad redirect', async () => {
		const clientId = await registerClient()
		expect(clientId.startsWith('aih_dcr_')).toBe(true)

		const bad = await register(
			new Request(`${BASE}/oauth/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					redirect_uris: ['http://evil.example.test/cb'],
				}),
			}),
		)
		expect(bad.status).toBe(400)
		expect(await bad.json()).toMatchObject({ error: 'invalid_redirect_uri' })
	})
})
