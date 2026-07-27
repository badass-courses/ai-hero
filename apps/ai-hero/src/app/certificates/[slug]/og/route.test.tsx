import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPublicSkillsWorkflowCertificateShare: vi.fn(),
	imageResponse: vi.fn(),
	readFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('next/navigation', () => ({
	notFound: vi.fn(() => {
		throw new Error('not-found')
	}),
}))
vi.mock('next/og', () => ({
	ImageResponse: class {
		constructor(element: React.ReactNode, options: Record<string, unknown>) {
			mocks.imageResponse(element, options)
			return new Response('png', {
				headers: { 'Content-Type': 'image/png' },
			})
		}
	},
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	getPublicSkillsWorkflowCertificateShare:
		mocks.getPublicSkillsWorkflowCertificateShare,
}))

import { GET, size } from './route'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
	mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue({
		slug: 'opaque-public-certificate-slug-123',
		learnerName: 'Joel Hooks',
		courseName: 'AI Hero Skills Workflow',
		completedAt: new Date('2026-07-18T12:00:00.000Z'),
	})
})

describe('certificate Open Graph image', () => {
	it('renders a real 1200x630 PNG response from the public projection', async () => {
		const response = await GET(
			new Request(
				'https://www.aihero.dev/certificates/opaque-public-certificate-slug-123/og',
			),
			{
				params: Promise.resolve({
					slug: 'opaque-public-certificate-slug-123',
				}),
			},
		)

		expect(size).toEqual({ width: 1200, height: 630 })
		expect(response).toBeInstanceOf(Response)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(mocks.imageResponse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ width: 1200, height: 630 }),
		)
		expect(JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0])).not.toContain(
			'contact-1',
		)
	})
})
