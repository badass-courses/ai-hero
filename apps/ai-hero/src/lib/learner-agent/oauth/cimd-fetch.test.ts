import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
	cacheSeconds,
	checkCimdUrl,
	CIMD_MAX_BYTES,
	createCimdFetcher,
	isPublicAddress,
} from './cimd-fetch'

describe('CIMD SSRF guard: addresses', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'224.0.0.1',
		'255.255.255.255',
		'::1',
		'::',
		'fe80::1',
		'fc00::1',
		'fd12:3456::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'64:ff9b::a00:1',
		'2002:7f00:1::',
		'not-an-ip',
	])('refuses %s', (address) => {
		expect(isPublicAddress(address)).toBe(false)
	})

	it.each([
		'93.184.216.34',
		'1.1.1.1',
		'2606:4700:4700::1111',
		'::ffff:1.1.1.1',
	])('allows public %s', (address) => {
		expect(isPublicAddress(address)).toBe(true)
	})
})

describe('CIMD SSRF guard: URL shape', () => {
	it.each([
		['http://client.example.com/meta.json', 'not-https'],
		['https://client.example.com:8443/meta.json', 'port'],
		['https://user:pw@client.example.com/meta.json', 'userinfo'],
		['https://client.example.com/meta.json#x', 'fragment'],
		['https://client.example.com/', 'no-path'],
		['https://127.0.0.1/meta.json', 'ip-literal'],
		['https://[::1]/meta.json', 'ip-literal'],
		['https://localhost/meta.json', 'private-name'],
		['https://metadata.internal/meta.json', 'private-name'],
		['https://intranet/meta.json', 'private-name'],
	])('refuses %s (%s)', (url, reason) => {
		expect(checkCimdUrl(url)).toEqual({ ok: false, reason })
	})

	it('accepts an HTTPS URL with a path', () => {
		expect(checkCimdUrl('https://client.example.com/oauth/meta.json').ok).toBe(
			true,
		)
	})
})

describe('CIMD cache lifetime', () => {
	it.each([
		[undefined, 300],
		['no-store', 0],
		['private, max-age=600', 0],
		['public, max-age=600', 600],
		['max-age=999999', 86400],
	])('%s caches for %d seconds', (header, seconds) => {
		expect(cacheSeconds(header)).toBe(seconds)
	})
})

describe('CIMD fetcher', () => {
	let server: http.Server
	let port: number
	const routes: Record<string, (res: http.ServerResponse) => void> = {
		'/ok.json': (res) => {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Cache-Control': 'max-age=60',
			})
			res.end(JSON.stringify({ client_id: 'x' }))
		},
		'/redirect.json': (res) => {
			res.writeHead(302, { Location: 'http://169.254.169.254/' })
			res.end()
		},
		'/big.json': (res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.write(`"${'a'.repeat(CIMD_MAX_BYTES)}`)
			res.end('"')
		},
		'/slow.json': () => undefined,
		'/text.json': (res) => {
			res.writeHead(200)
			res.end('<html>')
		},
	}

	beforeAll(async () => {
		server = http.createServer((req, res) => routes[req.url ?? '']?.(res))
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		port = (server.address() as AddressInfo).port
	})
	afterAll(() => {
		server.closeAllConnections()
		server.close()
	})

	// Plain HTTP to a local server, with the address check opened for the
	// test host only. Production uses HTTPS, port 443 and `isPublicAddress`.
	const localFetcher = (timeoutMs?: number) =>
		createCimdFetcher({
			resolve: async () => [{ address: '127.0.0.1', family: 4 }],
			isAllowed: (address) => address === '127.0.0.1',
			transport: (options, onResponse) => http.request(options, onResponse),
			connectPort: port,
			...(timeoutMs ? { timeoutMs } : {}),
		})

	it('reads a document and its cache lifetime', async () => {
		expect(await localFetcher()('https://client.example.com/ok.json')).toEqual({
			ok: true,
			document: { client_id: 'x' },
			maxAgeSeconds: 60,
		})
	})

	it('does not follow redirects', async () => {
		expect(
			await localFetcher()('https://client.example.com/redirect.json'),
		).toEqual({ ok: false, reason: 'redirect' })
	})

	it('stops at 64 KB', async () => {
		expect(await localFetcher()('https://client.example.com/big.json')).toEqual(
			{ ok: false, reason: 'too-large' },
		)
	})

	it('times out', async () => {
		expect(
			await localFetcher(200)('https://client.example.com/slow.json'),
		).toEqual({ ok: false, reason: 'timeout' })
	})

	it('refuses a body that is not JSON', async () => {
		expect(
			await localFetcher()('https://client.example.com/text.json'),
		).toEqual({ ok: false, reason: 'not-json' })
	})

	it('refuses a host whose DNS answer includes a private address', async () => {
		const fetcher = createCimdFetcher({
			resolve: async () => [
				{ address: '93.184.216.34', family: 4 },
				{ address: '127.0.0.1', family: 4 },
			],
			transport: (options, onResponse) => http.request(options, onResponse),
			connectPort: port,
		})
		expect(await fetcher('https://rebind.example.com/ok.json')).toEqual({
			ok: false,
			reason: 'blocked-address',
		})
	})
})
