import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPublicSkillsWorkflowCertificateShare: vi.fn(),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	imageResponse: vi.fn(),
	readFile: vi.fn(),
	contentResourceFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('next/og', () => ({
	ImageResponse: class {
		constructor(element: React.ReactNode, options: Record<string, any>) {
			mocks.imageResponse(element, options)
			return new Response('png', {
				headers: {
					'Content-Type': 'image/png',
					...(options.headers ?? {}),
				},
			})
		}
	},
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findFirst: mocks.contentResourceFindFirst },
			users: { findFirst: mocks.userFindFirst },
		},
	},
}))
vi.mock('@/lib/certificates', () => ({
	checkCertificateEligibility: vi.fn(),
	checkCohortCertificateEligibility: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility:
		mocks.checkSkillsWorkflowValuePathCertificateEligibility,
	isSkillsWorkflowCertificateResource: vi.fn(() => true),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	getPublicSkillsWorkflowCertificateShare:
		mocks.getPublicSkillsWorkflowCertificateShare,
}))

import { GET } from './route'

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

describe('public certificate PNG', () => {
	it('renders from the opaque share slug without reading contact identity', async () => {
		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?share=opaque-public-certificate-slug-123&user=contact-must-not-leak&resource=value-path%3Aai-hero-skills-workflow',
			),
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(mocks.getPublicSkillsWorkflowCertificateShare).toHaveBeenCalledWith(
			'opaque-public-certificate-slug-123',
		)
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(mocks.contentResourceFindFirst).not.toHaveBeenCalled()
		expect(mocks.userFindFirst).not.toHaveBeenCalled()
		expect(JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0])).not.toContain(
			'contact-must-not-leak',
		)
	})

	it('sets a safe filename only for the explicit download affordance', async () => {
		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?share=opaque-public-certificate-slug-123&download=1',
			),
		)

		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="joel-hooks-skills-workflow-certificate.png"',
		)
	})
})
