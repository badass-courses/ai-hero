import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn() }))

vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./rate-limit', () => ({ oauthRateLimit: mocks.rateLimit }))

import {
	cleanClientName,
	clearClientCache,
	clientFromMetadataDocument,
	mintDcrClientId,
	openDcrClientId,
	parseRegistration,
	resolveOAuthClient,
} from './client'
import { isAllowedRedirectUri, matchesRegisteredRedirect } from './redirect-uri'

const CIMD_URL = 'https://client.example.com/oauth/meta.json'
const doc = {
	client_id: CIMD_URL,
	client_name: 'Example Agent',
	redirect_uris: ['https://client.example.com/callback'],
}

beforeEach(() => {
	clearClientCache()
	mocks.rateLimit.mockReset().mockResolvedValue(true)
})

describe('redirect URI policy', () => {
	it.each([
		'https://claude.ai/api/mcp/auth_callback',
		'http://localhost:7777/callback',
		'http://127.0.0.1:53111/callback',
		'http://[::1]:8080/cb',
	])('allows %s', (uri) => expect(isAllowedRedirectUri(uri)).toBe(true))

	it.each([
		'http://example.com/callback',
		'https://example.com/callback#frag',
		'https://user:pw@example.com/callback',
		'cursor://anysphere.cursor-mcp/oauth/callback',
		'javascript:alert(1)',
		'/relative',
	])('refuses %s', (uri) => expect(isAllowedRedirectUri(uri)).toBe(false))

	it('matches exactly, except a loopback port', () => {
		const registered = [
			'https://app.example.com/cb',
			'http://127.0.0.1/callback',
		]
		expect(
			matchesRegisteredRedirect(registered, 'https://app.example.com/cb'),
		).toBe(true)
		expect(
			matchesRegisteredRedirect(registered, 'https://app.example.com/cb/'),
		).toBe(false)
		expect(
			matchesRegisteredRedirect(registered, 'https://app.example.com:444/cb'),
		).toBe(false)
		expect(
			matchesRegisteredRedirect(registered, 'http://127.0.0.1:9999/callback'),
		).toBe(true)
		expect(
			matchesRegisteredRedirect(registered, 'http://127.0.0.1:9999/other'),
		).toBe(false)
		expect(
			matchesRegisteredRedirect(registered, 'http://localhost:9999/callback'),
		).toBe(false)
	})
})

describe('stateless DCR', () => {
	it('seals the name and redirect URIs into the client id', () => {
		const parsed = parseRegistration({
			client_name: 'Claude Code (aihero)',
			redirect_uris: ['http://localhost:7777/callback'],
		})
		expect(parsed).toEqual({
			ok: true,
			clientName: 'Claude Code (aihero)',
			redirectUris: ['http://localhost:7777/callback'],
		})
		if (!parsed.ok) return
		const clientId = mintDcrClientId(parsed.clientName, parsed.redirectUris)
		expect(openDcrClientId(clientId as string)).toMatchObject({
			kind: 'dcr',
			clientName: 'Claude Code (aihero)',
			redirectUris: ['http://localhost:7777/callback'],
			clientHost: 'localhost:7777',
		})
		expect(openDcrClientId(`${clientId}x`)).toBeNull()
	})

	it('refuses grants and response types it cannot serve', () => {
		expect(
			parseRegistration({
				redirect_uris: ['https://a.example.com/cb'],
				grant_types: ['client_credentials'],
			}),
		).toMatchObject({ ok: false, error: 'invalid_client_metadata' })
		expect(
			parseRegistration({
				redirect_uris: ['https://a.example.com/cb'],
				response_types: ['token'],
			}),
		).toMatchObject({ ok: false, error: 'invalid_client_metadata' })
	})

	it('names a nameless client by its redirect host, and strips control characters', () => {
		expect(
			parseRegistration({ redirect_uris: ['https://a.example.com/cb'] }),
		).toMatchObject({ clientName: 'a.example.com' })
		expect(cleanClientName('Evil\u202e\u0000 App\n')).toBe('Evil App')
		expect(cleanClientName('x'.repeat(200))).toHaveLength(80)
	})
})

describe('CIMD clients', () => {
	it('validates the document against the URL it came from', () => {
		expect(clientFromMetadataDocument(CIMD_URL, doc)).toMatchObject({
			kind: 'cimd',
			clientName: 'Example Agent',
			clientHost: 'client.example.com',
		})
		expect(
			clientFromMetadataDocument(CIMD_URL, {
				...doc,
				client_id: 'https://other.example.com/meta.json',
			}),
		).toBeNull()
		expect(
			clientFromMetadataDocument(CIMD_URL, { ...doc, client_name: '' }),
		).toBeNull()
		expect(
			clientFromMetadataDocument(CIMD_URL, {
				...doc,
				redirect_uris: ['http://client.example.com/callback'],
			}),
		).toBeNull()
	})

	it('fetches once, then serves from cache for the document’s max-age', async () => {
		const fetchDocument = vi.fn(async () => ({
			ok: true as const,
			document: doc,
			maxAgeSeconds: 60,
		}))
		expect((await resolveOAuthClient(CIMD_URL, fetchDocument)).ok).toBe(true)
		expect((await resolveOAuthClient(CIMD_URL, fetchDocument)).ok).toBe(true)
		expect(fetchDocument).toHaveBeenCalledTimes(1)
	})

	it('does not cache a no-store document', async () => {
		const fetchDocument = vi.fn(async () => ({
			ok: true as const,
			document: doc,
			maxAgeSeconds: 0,
		}))
		await resolveOAuthClient(CIMD_URL, fetchDocument)
		await resolveOAuthClient(CIMD_URL, fetchDocument)
		expect(fetchDocument).toHaveBeenCalledTimes(2)
	})

	it('rate limits fetches per host and never fetches over budget', async () => {
		mocks.rateLimit.mockResolvedValue(false)
		const fetchDocument = vi.fn()
		expect(await resolveOAuthClient(CIMD_URL, fetchDocument)).toEqual({
			ok: false,
			reason: 'cimd-rate-limited',
		})
		expect(mocks.rateLimit).toHaveBeenCalledWith(
			'cimd-host',
			'client.example.com',
		)
		expect(fetchDocument).not.toHaveBeenCalled()
	})

	it('refuses client ids that are neither CIMD URLs nor sealed DCR ids', async () => {
		const fetchDocument = vi.fn()
		for (const id of ['', 'ABCDEF', 'http://client.example.com/meta.json'])
			expect((await resolveOAuthClient(id, fetchDocument)).ok).toBe(false)
		expect(fetchDocument).not.toHaveBeenCalled()
	})
})
