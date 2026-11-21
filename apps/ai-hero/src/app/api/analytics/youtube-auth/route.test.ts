import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

// The ?error= branch runs before any auth and returns HTML, so a crafted link
// must not be able to put markup or script on www.aihero.dev (sec-038).

vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		flush: vi.fn(async () => {}),
	},
	serializeError: (e: unknown) => String(e),
}))
vi.mock('@/lib/integration-token-store', () => ({
	getIntegrationRefreshToken: vi.fn(),
	integrationTokenStorageNotice: vi.fn(() => null),
	putIntegrationRefreshToken: vi.fn(),
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from './route'

const payload =
	'<script>alert(document.domain)</script><img src=x onerror=alert(1)>'

describe('GET /api/analytics/youtube-auth?error=', () => {
	it('escapes the error and never echoes markup', async () => {
		const res = await GET(
			new NextRequest(
				`https://www.aihero.dev/api/analytics/youtube-auth?error=${encodeURIComponent(payload)}`,
			),
		)
		const html = await res.text()
		expect(html).not.toContain('<script>')
		expect(html).not.toContain('<img')
		expect(html).toContain('&lt;script&gt;')
	})

	it('sends a CSP that forbids script', async () => {
		const res = await GET(
			new NextRequest(
				'https://www.aihero.dev/api/analytics/youtube-auth?error=access_denied',
			),
		)
		const csp = res.headers.get('content-security-policy') ?? ''
		expect(csp).toContain("default-src 'none'")
		expect(csp).not.toMatch(/script-src/)
	})
})
