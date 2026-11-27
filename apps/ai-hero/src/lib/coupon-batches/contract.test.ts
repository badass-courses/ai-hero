import { describe, expect, it } from 'vitest'
import {
	BatchProblem,
	checkDeadline,
	confirmPreview,
	issuePreview,
	MAX_MANIFEST_BYTES,
	MAX_MANIFEST_ITEMS,
	readManifest,
} from './contract'

const now = new Date('2026-11-27T07:59:59Z')
const terms = {
	productId: 'product-s00zs',
	percentageDiscount: 1,
	maxUses: 1,
	deadlineAt: '2026-11-29T00:00:00Z',
}
const body = {
	campaignRef: 'fixture-c5',
	templateId: 'c5-comp-v1',
	template: terms,
	items: [{ intentKey: 'intent-a' }],
}
const read = (value: unknown) =>
	readManifest(
		new Request('https://example.test', {
			method: 'POST',
			body: JSON.stringify(value),
		}),
	)

describe('desk comp manifest and preview', () => {
	it.each([
		{ templateId: 'generic-free' },
		{ template: { ...terms, productId: 'other' } },
		{ template: { ...terms, percentageDiscount: 0.5 } },
		{ template: { ...terms, maxUses: 2 } },
		{ template: { ...terms, default: true } },
		{ template: { ...terms, bypassSoldOut: true } },
		{ template: { ...terms, deadlineAt: 'forever' } },
		{ items: [{ intentKey: 'intent-a', contactId: 'not-desk' }] },
	])('rejects policy and envelope overrides %#', async (override) => {
		await expect(read({ ...body, ...override })).rejects.toBeInstanceOf(
			BatchProblem,
		)
	})

	it('binds receipts to actor, policy, normalized items, and time', async () => {
		const a = await read(body)
		const b = await read({ ...body, items: [{ intentKey: 'intent-b' }] })
		try {
			checkDeadline(a.terms.deadlineAt, now)
			const receipt = issuePreview('actor-a', a.fingerprint, now, 'synthetic')
			expect(() =>
				confirmPreview(receipt, 'actor-a', a.fingerprint, now, 'synthetic'),
			).not.toThrow()
			expect(() =>
				confirmPreview(receipt, 'actor-b', a.fingerprint, now, 'synthetic'),
			).toThrow('preview_required')
			expect(() =>
				confirmPreview(receipt, 'actor-a', b.fingerprint, now, 'synthetic'),
			).toThrow('preview_required')
			expect(() =>
				confirmPreview(
					receipt,
					'actor-a',
					a.fingerprint,
					new Date(+now + 600_000),
					'synthetic',
				),
			).toThrow('preview_required')
			expect(() => checkDeadline(now.toISOString(), now)).toThrow(
				'invalid_deadline',
			)
		} finally {
			await a.close()
			await b.close()
		}
	})

	it('accepts the exact item cap and rejects one more with 413', async () => {
		const items = Array.from({ length: MAX_MANIFEST_ITEMS }, (_, i) => ({
			intentKey: `limit-${i}`,
		}))
		const manifest = await read({ ...body, items })
		try {
			expect(manifest.total).toBe(MAX_MANIFEST_ITEMS)
		} finally {
			await manifest.close()
		}
		await expect(
			read({ ...body, items: [...items, { intentKey: 'over-limit' }] }),
		).rejects.toMatchObject({ status: 413, code: 'manifest_too_large' })
	})

	it('bounds streamed wire bytes even without an honest content length', async () => {
		const manifest = JSON.stringify(body)
		const atLimit = manifest.padEnd(MAX_MANIFEST_BYTES, ' ')
		const exact = await readManifest(
			new Request('https://example.test', { method: 'POST', body: atLimit }),
		)
		await exact.close()
		const bytes = new TextEncoder().encode(atLimit + ' ')
		for (const headers of [undefined, { 'content-length': '1' }]) {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.subarray(0, bytes.length - 1))
					controller.enqueue(bytes.subarray(bytes.length - 1))
					controller.close()
				},
			})
			await expect(
				readManifest(
					new Request('https://example.test', {
						method: 'POST',
						headers,
						body: stream,
						duplex: 'half',
					} as RequestInit),
				),
			).rejects.toMatchObject({ status: 413, code: 'manifest_too_large' })
		}
	})

	it('spools a single 3,058-item request and iterates it in bounded pages', async () => {
		const items = Array.from({ length: 3058 }, (_, i) => ({
			intentKey: `intent-${i}`,
		}))
		const manifest = await read({
			...body,
			template: { ...terms, deadlineAt: '2026-11-28T16:00:00-08:00' },
			items,
		})
		const pages = []
		try {
			for await (const chunk of manifest.pages()) pages.push(chunk.length)
			expect(manifest.total).toBe(3058)
			expect(manifest.terms.deadlineAt).toBe('2026-11-29T00:00:00.000Z')
			expect(pages).toEqual([...Array(30).fill(100), 58])
		} finally {
			await manifest.close()
		}
	})
})
