import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPublicSkillsWorkflowCertificateShare: vi.fn(),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	imageResponse: vi.fn(),
	readFile: vi.fn(),
	contentResourceFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
	checkCertificateEligibility: vi.fn(),
	checkCohortCertificateEligibility: vi.fn(),
	contactFindFirst: vi.fn(),
	intentsFindMany: vi.fn(),
	delivery: vi.fn(),
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
			contact: { findFirst: mocks.contactFindFirst },
			sideEffectIntent: { findMany: mocks.intentsFindMany },
		},
	},
}))
vi.mock('@/lib/certificates', () => ({
	checkCertificateEligibility: mocks.checkCertificateEligibility,
	checkCohortCertificateEligibility: mocks.checkCohortCertificateEligibility,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility:
		mocks.checkSkillsWorkflowValuePathCertificateEligibility,
	isSkillsWorkflowCertificateResource: (resource: string) =>
		resource === 'value-path:ai-hero-skills-workflow',
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	getPublicSkillsWorkflowCertificateShare:
		mocks.getPublicSkillsWorkflowCertificateShare,
}))

vi.mock('@/lib/subscriber-marketing/drovr-certificate-completion', () => ({
	readDrovrCertificateCompletion: mocks.delivery,
}))

import { GET } from './route'

beforeEach(() => {
	vi.resetAllMocks()
	mocks.contactFindFirst.mockResolvedValue({
		id: 'test-contact',
		name: 'Test Learner',
		email: 'learner@example.test',
	})
	mocks.intentsFindMany.mockResolvedValue([])
	mocks.delivery.mockResolvedValue({ status: 'not-completed' })
	mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
	mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue({
		slug: 'opaque-public-certificate-slug-123',
		learnerName: 'Joel Hooks',
		courseName: 'AI Hero Skills Workflow',
		completedAt: new Date('2026-07-18T12:00:00.000Z'),
	})
})

describe('value-path certificate PNG', () => {
	const request = () =>
		new Request(
			'https://www.aihero.dev/api/certificates?resource=value-path%3Aai-hero-skills-workflow&user=test-contact',
		)
	async function useRealResolver() {
		const actual = await vi.importActual<
			typeof import('@/lib/subscriber-marketing/value-path-certificates')
		>('@/lib/subscriber-marketing/value-path-certificates')
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockImplementation(
			actual.checkSkillsWorkflowValuePathCertificateEligibility,
		)
	}
	it.each(['legacy', 'drovr'])(
		'renders proven %s completion',
		async (source) => {
			await useRealResolver()
			if (source === 'legacy') {
				mocks.intentsFindMany.mockResolvedValue([
					{
						status: 'completed',
						completedAt: '2026-07-18T12:00:00Z',
						metadata: { emailResourceId: 'ai-hero-skills-workflow.email-6' },
					},
				])
				mocks.delivery.mockResolvedValue({ status: 'unavailable' })
			} else {
				mocks.delivery.mockResolvedValue({
					status: 'completed',
					completedAt: new Date('2026-07-18T12:00:00Z'),
				})
			}
			const response = await GET(request())
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toBe('image/png')
			expect(mocks.contentResourceFindFirst).not.toHaveBeenCalled()
			expect(mocks.userFindFirst).not.toHaveBeenCalled()
			expect(JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0])).toContain(
				'July 18th, 2026',
			)
		},
	)
	it.each([
		['value-path-not-complete', 422],
		['completion-evidence-unavailable', 503],
	])('maps %s to %s without rendering', async (reason, status) => {
		await useRealResolver()
		mocks.delivery.mockResolvedValue({
			status:
				reason === 'completion-evidence-unavailable'
					? 'unavailable'
					: 'not-completed',
		})
		const response = await GET(request())
		expect(response.status).toBe(status)
		expect(mocks.imageResponse).not.toHaveBeenCalled()
	})
})

describe('existing workshop and cohort certificates', () => {
	it.each(['workshop', 'cohort'])('preserves %s rendering', async (type) => {
		mocks.contentResourceFindFirst.mockResolvedValue({
			id: 'test-resource',
			type,
			fields: { title: 'Test Course' },
		})
		mocks.userFindFirst.mockResolvedValue({ name: 'Test Learner' })
		mocks.checkCertificateEligibility.mockResolvedValue({
			hasCompletedModule: true,
			date: new Date('2026-07-18T12:00:00Z'),
		})
		mocks.checkCohortCertificateEligibility.mockResolvedValue({
			hasCompletedCohort: true,
			date: new Date('2026-07-18T12:00:00Z'),
		})
		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?resource=test-resource&user=test-user',
			),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(
			type === 'cohort'
				? mocks.checkCohortCertificateEligibility
				: mocks.checkCertificateEligibility,
		).toHaveBeenCalledWith('test-resource', 'test-user')
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
		expect(
			JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0]),
		).not.toContain('contact-must-not-leak')
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
