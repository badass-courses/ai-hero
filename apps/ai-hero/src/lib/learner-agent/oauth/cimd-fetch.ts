import dns from 'node:dns'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * SECURITY REVIEW (Bastion): the Client ID Metadata Document fetcher.
 *
 * A CIMD `client_id` is a URL the client chooses, so fetching it is a
 * server-side request to an attacker-chosen host. The guard:
 *
 * - HTTPS only, default port 443, no userinfo, no fragment, a real path.
 * - IP-literal hosts are refused outright (Node skips `lookup` for them).
 * - DNS resolution happens inside the socket's own `lookup`, and every
 *   resolved address must be public. The socket connects to an address
 *   that was checked, so a rebinding DNS answer cannot slip past.
 * - A fresh agent per fetch: no pooled socket to some earlier address.
 * - No redirects followed, 5 second overall timeout, 64 KB body cap.
 *
 * Per-host rate limiting and caching live in the caller (`client.ts`).
 */

export const CIMD_TIMEOUT_MS = 5_000
export const CIMD_MAX_BYTES = 64 * 1024
const DEFAULT_MAX_AGE_SECONDS = 300
const MAX_MAX_AGE_SECONDS = 24 * 60 * 60

const blockedV4 = new net.BlockList()
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const)
	blockedV4.addSubnet(network, prefix, 'ipv4')

const blockedV6 = new net.BlockList()
for (const [network, prefix] of [
	// IPv4-compatible (deprecated), including :: and ::1. A stack that
	// still routes them reaches the IPv4 host they embed.
	['::', 96],
	['::ffff:0:0', 96],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8],
] as const)
	blockedV6.addSubnet(network, prefix, 'ipv6')

/** Whether a resolved address is safe to connect to: public unicast only. */
export function isPublicAddress(address: string) {
	const version = net.isIP(address)
	if (version === 4) return !blockedV4.check(address, 'ipv4')
	if (version === 6) {
		// An IPv4-mapped address reaches the IPv4 host it embeds.
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
		if (mapped?.[1]) return isPublicAddress(mapped[1])
		return !blockedV6.check(address, 'ipv6')
	}
	return false
}

export type CimdUrlCheck =
	| { ok: true; url: URL }
	| { ok: false; reason: string }

/** The shape a CIMD URL must have before anything is resolved. */
export function checkCimdUrl(clientId: string): CimdUrlCheck {
	if (clientId.length > 2048) return { ok: false, reason: 'too-long' }
	let url: URL
	try {
		url = new URL(clientId)
	} catch {
		return { ok: false, reason: 'not-a-url' }
	}
	if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' }
	if (url.port && url.port !== '443') return { ok: false, reason: 'port' }
	if (url.username || url.password) return { ok: false, reason: 'userinfo' }
	if (url.hash || clientId.includes('#'))
		return { ok: false, reason: 'fragment' }
	if (url.pathname === '/' || url.pathname === '')
		return { ok: false, reason: 'no-path' }
	const host = url.hostname
	if (net.isIP(host) || host.startsWith('['))
		return { ok: false, reason: 'ip-literal' }
	if (
		!host.includes('.') ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal')
	)
		return { ok: false, reason: 'private-name' }
	return { ok: true, url }
}

type Resolved = ReadonlyArray<{ address: string; family: number }>
type Resolve = (hostname: string) => Promise<Resolved>

const resolveAll: Resolve = (hostname) =>
	dns.promises.lookup(hostname, { all: true, verbatim: true })

class BlockedAddressError extends Error {
	readonly code = 'EBLOCKEDADDRESS'
}

/** A socket `lookup` that refuses unless every resolved address is public. */
export function guardedLookup(
	resolve: Resolve = resolveAll,
	isAllowed: (address: string) => boolean = isPublicAddress,
): net.LookupFunction {
	return (hostname, options, callback) => {
		resolve(hostname).then(
			(addresses) => {
				const first = addresses[0]
				if (!first || addresses.some(({ address }) => !isAllowed(address))) {
					callback(new BlockedAddressError('blocked address'), '', 4)
					return
				}
				if (options.all) {
					;(callback as unknown as (e: null, a: Resolved) => void)(
						null,
						addresses,
					)
					return
				}
				callback(null, first.address, first.family)
			},
			(error: NodeJS.ErrnoException) => callback(error, '', 4),
		)
	}
}

/** Seconds a fetched document may be reused, from its Cache-Control. */
export function cacheSeconds(cacheControl: string | undefined) {
	if (!cacheControl) return DEFAULT_MAX_AGE_SECONDS
	const directives = cacheControl.toLowerCase()
	if (/\b(no-store|no-cache|private)\b/.test(directives)) return 0
	if (!/\bmax-age\b/.test(directives)) return DEFAULT_MAX_AGE_SECONDS
	// Quoted values are legal (RFC 9111 §5.2). One we can't read caches nothing.
	const maxAge = /\bmax-age\s*=\s*(?:"(\d+)"|(\d+))/.exec(directives)
	const seconds = maxAge?.[1] ?? maxAge?.[2]
	if (!seconds) return 0
	return Math.min(Number(seconds), MAX_MAX_AGE_SECONDS)
}

export type CimdFetchResult =
	| { ok: true; document: unknown; maxAgeSeconds: number }
	| { ok: false; reason: string }

type Transport = (
	options: https.RequestOptions,
	onResponse: (response: IncomingMessage) => void,
) => ReturnType<typeof https.request>

export type CimdFetcherOptions = {
	resolve?: Resolve
	isAllowed?: (address: string) => boolean
	/** Tests only: a plain-HTTP transport and port against a local server. */
	transport?: Transport
	connectPort?: number
	timeoutMs?: number
}

export function createCimdFetcher(options: CimdFetcherOptions = {}) {
	const lookup = guardedLookup(options.resolve, options.isAllowed)
	const transport: Transport =
		options.transport ?? ((opts, cb) => https.request(opts, cb))
	const timeoutMs = options.timeoutMs ?? CIMD_TIMEOUT_MS

	return (clientId: string): Promise<CimdFetchResult> => {
		const checked = checkCimdUrl(clientId)
		if (!checked.ok) return Promise.resolve(checked)
		const { url } = checked

		return new Promise<CimdFetchResult>((resolve) => {
			let settled = false
			const finish = (result: CimdFetchResult) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve(result)
			}

			const request = transport(
				{
					method: 'GET',
					hostname: url.hostname,
					port: options.connectPort ?? 443,
					path: `${url.pathname}${url.search}`,
					servername: url.hostname,
					headers: {
						Accept: 'application/json',
						'User-Agent': 'AIHero-MCP-OAuth/1',
					},
					lookup,
					agent: false,
				},
				(response) => {
					if (response.statusCode !== 200) {
						response.resume()
						request.destroy()
						const status = response.statusCode ?? 0
						finish({
							ok: false,
							reason:
								status >= 300 && status < 400 ? 'redirect' : `status-${status}`,
						})
						return
					}
					const declared = Number(response.headers['content-length'])
					if (Number.isFinite(declared) && declared > CIMD_MAX_BYTES) {
						request.destroy()
						finish({ ok: false, reason: 'too-large' })
						return
					}
					const chunks: Buffer[] = []
					let size = 0
					response.on('data', (chunk: Buffer) => {
						size += chunk.length
						if (size > CIMD_MAX_BYTES) {
							request.destroy()
							finish({ ok: false, reason: 'too-large' })
							return
						}
						chunks.push(chunk)
					})
					response.on('end', () => {
						try {
							finish({
								ok: true,
								document: JSON.parse(
									Buffer.concat(chunks).toString('utf8'),
								) as unknown,
								maxAgeSeconds: cacheSeconds(response.headers['cache-control']),
							})
						} catch {
							finish({ ok: false, reason: 'not-json' })
						}
					})
					response.on('error', () => finish({ ok: false, reason: 'network' }))
				},
			)
			const timer = setTimeout(() => {
				request.destroy()
				finish({ ok: false, reason: 'timeout' })
			}, timeoutMs)
			request.on('error', (error: NodeJS.ErrnoException) =>
				finish({
					ok: false,
					reason:
						error.code === 'EBLOCKEDADDRESS' ? 'blocked-address' : 'network',
				}),
			)
			request.end()
		})
	}
}

export const fetchClientMetadataDocument = createCimdFetcher()
