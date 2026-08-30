import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPublicSkillsWorkflowCertificateShare: vi.fn(),
}))

vi.mock('next/navigation', () => ({
	notFound: vi.fn(() => {
		throw new Error('not-found')
	}),
	useParams: vi.fn(() => ({})),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	SKILLS_WORKFLOW_CERTIFICATE_RESOURCE: 'value-path:ai-hero-skills-workflow',
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	SKILLS_WORKFLOW_FREE_COURSE_PATH:
		'/skills/subscribe?utm_source=certificate&utm_medium=share&utm_campaign=skills-workflow-certificate',
	getPublicSkillsWorkflowCertificateShare:
		mocks.getPublicSkillsWorkflowCertificateShare,
	buildSkillsWorkflowCertificateShareUrl: vi.fn(
		({ slug, baseUrl }: { slug: string; baseUrl?: string }) =>
			baseUrl ? `${baseUrl}/certificates/${slug}` : `/certificates/${slug}`,
	),
	buildSkillsWorkflowCertificateShareImageUrl: vi.fn(
		({ slug }: { slug: string }) => `/api/certificates?share=${slug}`,
	),
}))

import PublicCertificatePage, { generateMetadata } from './page'

const share = {
	slug: 'opaque-public-certificate-slug-123',
	resourceId: 'value-path:ai-hero-skills-workflow',
	learnerName: 'Joel Hooks',
	courseName: 'AI Hero Skills Workflow',
	completedAt: new Date('2026-07-18T12:00:00.000Z'),
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue(share)
})

describe('public certificate permalink', () => {
	it('renders only the public certificate projection and a tracked free-course CTA', async () => {
		const page = await PublicCertificatePage({
			params: Promise.resolve({ slug: share.slug }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('Joel Hooks')
		expect(markup).toContain('AI Hero Skills Workflow')
		expect(markup).toContain('July 18, 2026')
		expect(markup).toContain(
			'/api/certificates?share=opaque-public-certificate-slug-123',
		)
		expect(markup).toContain('Start the free course')
		expect(markup).toContain(
			'utm_source=certificate&amp;utm_medium=share&amp;utm_campaign=skills-workflow-certificate',
		)
		expect(markup).not.toContain('Share on X')
		expect(markup).not.toContain('LinkedIn')
		expect(markup).not.toContain('contact-1')
		expect(markup).not.toContain('joel@example.com')
		expect(markup).not.toContain('pt=')
		expect(markup).not.toContain('expiresAt')
	})

	it('renders LinkedIn and X sharing without the Skills CTA for Crash Course', async () => {
		mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue({
			...share,
			resourceId: 'workshop-2ozd9',
			courseName: 'AI Coding Crash Course',
		})

		const page = await PublicCertificatePage({
			params: Promise.resolve({ slug: share.slug }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('AI Coding Crash Course')
		expect(markup).toContain('Share on X')
		expect(markup).toContain('LinkedIn')
		expect(markup).toContain(
			'https%3A%2F%2Fwww.aihero.dev%2Fcertificates%2Fopaque-public-certificate-slug-123',
		)
		expect(markup).not.toContain('Start the free course')
		expect(markup).not.toContain('joel@example.com')
	})

	it('publishes absolute Open Graph and Twitter metadata for the permalink', async () => {
		const metadata = await generateMetadata({
			params: Promise.resolve({ slug: share.slug }),
		})

		expect(metadata.title).toBe(
			'Joel Hooks completed the AI Hero Skills Workflow',
		)
		expect(metadata.openGraph).toMatchObject({
			title: 'Joel Hooks completed the AI Hero Skills Workflow',
			url: `https://www.aihero.dev/certificates/${share.slug}`,
			images: [
				{
					url: `https://www.aihero.dev/certificates/${share.slug}/og`,
					width: 1200,
					height: 630,
				},
			],
		})
		expect(metadata.twitter).toMatchObject({
			card: 'summary_large_image',
			title: 'Joel Hooks completed the AI Hero Skills Workflow',
			images: [`https://www.aihero.dev/certificates/${share.slug}/og`],
		})
		expect(JSON.stringify(metadata)).not.toContain('contact-1')
		expect(JSON.stringify(metadata)).not.toContain('joel@example.com')
	})
})
