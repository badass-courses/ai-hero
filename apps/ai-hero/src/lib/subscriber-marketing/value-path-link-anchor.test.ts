import { describe, expect, it, vi } from 'vitest'

import {
	createMemoryValuePathLinkAnchorStore,
	resolveValuePathLinkAnchor,
	VALUE_PATH_LINK_LIFETIME_DAYS,
	VALUE_PATH_LINK_REISSUE_WITHIN_DAYS,
	valuePathLinkAnchorRowKey,
	valuePathLinkFingerprint,
	type ValuePathLinkAnchorStore,
} from './value-path-link-anchor'

const key = {
	contactId: 'contact-1',
	valuePathSlug: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-0',
	fingerprint: 'f1',
}

const page = (id: string, slug: string, position: number) => ({
	id,
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug,
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-0',
		position,
	},
})

describe('value-path link anchor', () => {
	it('lives 120 days and re-issues inside its last 30', () => {
		expect(VALUE_PATH_LINK_LIFETIME_DAYS).toBe(120)
		expect(VALUE_PATH_LINK_REISSUE_WITHIN_DAYS).toBe(30)
	})

	it('re-issues an anchor within 30 days of its expiry, so a resumed contact never gets a dead link', async () => {
		const store = createMemoryValuePathLinkAnchorStore()
		const first = await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2026-09-26T16:00:00.000Z',
		})
		// 90 days later: 30 days left, so still the first issue.
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2026-12-25T16:00:00.000Z',
			}),
		).resolves.toEqual(first)
		// One second later: under 30 days left, so a fresh 120-day issue.
		const renewed = await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2026-12-25T16:00:01.000Z',
		})
		expect(renewed).toEqual({
			issuedAt: '2026-12-25T16:00:01.000Z',
			expiresAt: '2027-04-24T16:00:01.000Z',
		})
		// And the renewal is what every later issue keeps.
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2027-01-10T16:00:00.000Z',
			}),
		).resolves.toEqual(renewed)
		// Long after expiry (a contact resumed after months) also renews.
		const resumed = await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2027-09-01T00:00:00.000Z',
		})
		expect(resumed?.issuedAt).toBe('2027-09-01T00:00:00.000Z')
	})

	it('takes the winning renewal when a concurrent sender renewed first', async () => {
		const stale = {
			issuedAt: '2026-01-01T00:00:00.000Z',
			expiresAt: '2026-05-01T00:00:00.000Z',
		}
		const winner = {
			issuedAt: '2026-04-20T23:59:59.000Z',
			expiresAt: '2026-08-18T23:59:59.000Z',
		}
		let reads = 0
		const renew = vi.fn(async () => 'stale' as const)
		const store: ValuePathLinkAnchorStore = {
			find: async () => (reads++ === 0 ? stale : winner),
			insert: async () => 'exists',
			renew,
		}
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2026-04-21T00:00:00.000Z',
			}),
		).resolves.toEqual(winner)
		expect(renew).toHaveBeenCalledWith(key, stale, {
			issuedAt: '2026-04-21T00:00:00.000Z',
			expiresAt: '2026-08-19T00:00:00.000Z',
		})
	})

	it('anchors at the first issue and keeps it for every later issue', async () => {
		const store = createMemoryValuePathLinkAnchorStore()
		const first = await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2026-09-26T16:00:00.000Z',
		})
		expect(first).toEqual({
			issuedAt: '2026-09-26T16:00:00.000Z',
			expiresAt: '2027-01-24T16:00:00.000Z',
		})
		const later = await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2026-10-16T16:00:00.000Z',
		})
		expect(later).toEqual(first)
	})

	it('re-anchors when an input changes (a new fingerprint)', async () => {
		const store = createMemoryValuePathLinkAnchorStore()
		await resolveValuePathLinkAnchor({
			store,
			key,
			now: '2026-09-26T16:00:00.000Z',
		})
		const changed = await resolveValuePathLinkAnchor({
			store,
			key: { ...key, fingerprint: 'f2' },
			now: '2026-10-01T16:00:00.000Z',
		})
		expect(changed).toEqual({
			issuedAt: '2026-10-01T16:00:00.000Z',
			expiresAt: '2027-01-29T16:00:00.000Z',
		})
	})

	it('takes the winning row when a concurrent first issue got there first', async () => {
		const winner = {
			issuedAt: '2026-09-26T15:59:59.000Z',
			expiresAt: '2027-01-24T15:59:59.000Z',
		}
		let reads = 0
		const store: ValuePathLinkAnchorStore = {
			find: async () => (reads++ === 0 ? undefined : winner),
			insert: async () => 'exists',
			renew: async () => 'stale',
		}
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2026-09-26T16:00:00.000Z',
			}),
		).resolves.toEqual(winner)
	})

	it('answers undefined (use the legacy expiry) and warns when the store is unavailable', async () => {
		const warn = vi.fn()
		const store: ValuePathLinkAnchorStore = {
			find: async () => {
				throw Object.assign(
					new Error("Table 'AI_ValuePathLinkAnchor' doesn't exist"),
					{
						errno: 1146,
					},
				)
			},
			insert: async () => 'inserted',
			renew: async () => 'renewed',
		}
		await expect(
			resolveValuePathLinkAnchor({
				store,
				key,
				now: '2026-09-26T16:00:00.000Z',
				warn,
			}),
		).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledWith(
			'value_path.link_anchor.unavailable',
			expect.objectContaining({
				error: expect.stringContaining('AI_ValuePathLinkAnchor'),
			}),
		)
	})

	it('keys the row by one fixed-length digest, because four varchars exceed MySQL index limits', () => {
		const rowKey = valuePathLinkAnchorRowKey(key)
		expect(rowKey).toMatch(/^[0-9a-f]{64}$/)
		expect(valuePathLinkAnchorRowKey({ ...key })).toBe(rowKey)
		for (const field of [
			'contactId',
			'valuePathSlug',
			'emailResourceId',
			'fingerprint',
		] as const) {
			expect(
				valuePathLinkAnchorRowKey({ ...key, [field]: `${key[field]}x` }),
			).not.toBe(rowKey)
		}
		// Delimited, so a shifted boundary is a different key.
		expect(
			valuePathLinkAnchorRowKey({
				...key,
				contactId: 'contact',
				valuePathSlug: `1${key.valuePathSlug}`,
			}),
		).not.toBe(valuePathLinkAnchorRowKey({ ...key, contactId: 'contact1' }))
	})

	it('fingerprints the inputs that shape the URL, not their order', () => {
		const base = {
			kitSubscriberId: 'kit-1',
			baseUrl: 'https://www.aihero.dev',
			secret: 'secret-a',
			answerPages: [page('a', 'first', 1), page('b', 'second', 2)],
		}
		const fp = valuePathLinkFingerprint(base)
		expect(fp).toMatch(/^[0-9a-f]{64}$/)
		expect(
			valuePathLinkFingerprint({
				...base,
				answerPages: [...base.answerPages].reverse(),
			}),
		).toBe(fp)
		expect(
			valuePathLinkFingerprint({ ...base, kitSubscriberId: 'kit-2' }),
		).not.toBe(fp)
		expect(
			valuePathLinkFingerprint({ ...base, baseUrl: 'https://aihero.dev' }),
		).not.toBe(fp)
		expect(valuePathLinkFingerprint({ ...base, secret: 'secret-b' })).not.toBe(
			fp,
		)
		expect(
			valuePathLinkFingerprint({
				...base,
				answerPages: [page('a', 'first-renamed', 1), page('b', 'second', 2)],
			}),
		).not.toBe(fp)
		expect(fp).not.toContain('secret-a')
	})
})
