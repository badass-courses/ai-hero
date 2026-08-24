import type { ReactNode } from 'react'
import type { Lesson } from '@/lib/lessons'
import type { MinimalWorkshop } from '@/lib/workshops'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	compileMDX: vi.fn(),
	getAbilityForResource: vi.fn(),
	getAiCodingDictionary: vi.fn(),
	redirect: vi.fn(),
	notFound: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
}))

vi.mock('next/navigation', () => ({
	redirect: mocks.redirect,
	notFound: mocks.notFound,
}))

vi.mock('@/utils/compile-mdx', () => ({
	compileMDX: mocks.compileMDX,
}))

vi.mock('@/utils/get-current-ability-rules', () => ({
	getAbilityForResource: mocks.getAbilityForResource,
}))

vi.mock('@/lib/ai-coding-dictionary', () => ({
	getAiCodingDictionary: mocks.getAiCodingDictionary,
}))

vi.mock('@/lib/lessons-query', () => ({
	getLessonVideoPlaybackResource: vi.fn(),
	getLessonVideoTranscript: vi.fn(),
}))

vi.mock('@/server/logger', () => ({
	log: { warn: mocks.warn, debug: mocks.debug },
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

vi.mock('next/image', () => ({ default: () => null }))
vi.mock('@coursebuilder/ui', () => ({ Skeleton: () => null }))
vi.mock('@coursebuilder/ui/hooks/use-video-player-overlay', () => ({
	VideoPlayerOverlayProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@coursebuilder/utils/cn', () => ({
	cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))
vi.mock('@/app/(content)/_components/authed-video-player', () => ({
	AuthedVideoPlayer: () => null,
}))
vi.mock('@/app/(content)/_components/lesson-controls', () => ({
	LessonControls: () => null,
}))
vi.mock('@/app/(content)/_components/video-player-overlay', () => ({
	default: () => null,
}))
vi.mock('@/app/(content)/_components/video-transcript-renderer', () => ({
	Transcript: () => null,
}))
vi.mock('@/app/(content)/posts/_components/post-toc', () => ({
	default: () => null,
}))
vi.mock('@/app/(content)/workshops/_components/up-next', () => ({
	default: () => null,
}))
vi.mock(
	'@/app/(content)/workshops/_components/workshop-pricing-server',
	() => ({ WorkshopPricing: () => null }),
)
vi.mock('@/components/content-read-tracker', () => ({
	ContentReadTracker: () => null,
}))
vi.mock('@/components/player-skeleton', () => ({
	PlayerContainerSkeleton: () => null,
}))
vi.mock('@/hooks/use-active-heading', () => ({
	ActiveHeadingProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../_components/lesson-body', () => ({
	LessonBody: () => null,
}))

import { LessonPage } from './shared-page'

const lesson = {
	id: 'lesson-1',
	type: 'lesson',
	fields: {
		slug: 'lesson-1',
		title: 'Office Hours',
		body: '<OfficeHoursSchedule cohortId="cohort-1" />',
	},
	resources: [],
} as unknown as Lesson

const workshop = {
	id: 'workshop-1',
	type: 'workshop',
	fields: { slug: 'workshop-1', title: 'Workshop' },
} as unknown as MinimalWorkshop

const baseAbility = {
	canViewLesson: true,
	canViewWorkshop: false,
	canInviteTeam: false,
	isRegionRestricted: false,
	isPendingOpenAccess: false,
	canCreate: false,
}

function renderLessonPage() {
	return LessonPage({
		lesson,
		workshop,
		params: { module: 'workshop-1', lesson: 'lesson-1' },
		searchParams: {},
	})
}

describe('LessonPage office-hours authorization context', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.redirect.mockImplementation(() => {
			throw new Error('NEXT_REDIRECT')
		})
		mocks.notFound.mockImplementation(() => {
			throw new Error('NEXT_NOT_FOUND')
		})
		mocks.getAiCodingDictionary.mockResolvedValue({ entries: [] })
		mocks.compileMDX.mockResolvedValue({ content: null })
	})

	it('redirects a non-purchaser before MDX compilation', async () => {
		mocks.getAbilityForResource.mockResolvedValue({
			...baseAbility,
			canViewLesson: false,
		})

		await expect(renderLessonPage()).rejects.toThrow('NEXT_REDIRECT')

		expect(mocks.getAiCodingDictionary).not.toHaveBeenCalled()
		expect(mocks.compileMDX).not.toHaveBeenCalled()
	})

	it('does not put protected workshop context into an anonymous free lesson', async () => {
		mocks.getAbilityForResource.mockResolvedValue(baseAbility)

		await renderLessonPage()
		await vi.waitFor(() => expect(mocks.compileMDX).toHaveBeenCalledOnce())

		const context = mocks.compileMDX.mock.calls[0]?.[3]
		expect(context).not.toHaveProperty('officeHoursWorkshopId')
	})

	it('puts workshop context into a purchaser lesson for data-boundary recheck', async () => {
		mocks.getAbilityForResource.mockResolvedValue({
			...baseAbility,
			canViewWorkshop: true,
		})

		await renderLessonPage()
		await vi.waitFor(() => expect(mocks.compileMDX).toHaveBeenCalledOnce())

		expect(mocks.compileMDX.mock.calls[0]?.[3]).toMatchObject({
			lessonId: 'lesson-1',
			officeHoursWorkshopId: 'workshop-1',
		})
	})
})
