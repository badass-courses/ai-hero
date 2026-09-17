import { isValidElement, type ReactNode } from 'react'
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
	getLessonVideoPlaybackResource: vi.fn(),
	getPlaybackPositionForResource: vi.fn(),
	player: vi.fn(),
	overlay: vi.fn(),
	controls: vi.fn(),
	commerce: vi.fn(),
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
	getLessonVideoPlaybackResource: mocks.getLessonVideoPlaybackResource,
	getLessonVideoTranscript: vi.fn(),
}))

vi.mock('@/lib/progress', () => ({
	getPlaybackPositionForResource: mocks.getPlaybackPositionForResource,
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://example.test' },
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
	VideoPlayerOverlayProvider: ({ children }: { children: ReactNode }) =>
		children,
}))
vi.mock('@coursebuilder/utils/cn', () => ({
	cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}))
vi.mock('@/app/(content)/_components/authed-video-player', () => ({
	AuthedVideoPlayer: mocks.player,
}))
vi.mock('@/app/(content)/_components/lesson-controls', () => ({
	LessonControls: mocks.controls,
}))
vi.mock('@/app/(content)/_components/video-player-overlay', () => ({
	default: mocks.overlay,
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
	() => ({
		WorkshopPricing: ({
			children,
		}: {
			children: (props: object) => ReactNode
		}) => {
			mocks.commerce()
			return children({})
		},
	}),
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

// Evaluate this server page's async component tree with its client boundaries
// mocked above. Unlike calling LessonPage alone, this executes PlayerContainer
// and any pricing wrapper within Suspense (not its fallback).
async function resolveServerTree(node: ReactNode): Promise<void> {
	if (Array.isArray(node)) {
		for (const child of node) await resolveServerTree(child)
		return
	}
	if (!isValidElement<{ children?: ReactNode }>(node)) return
	if (typeof node.type === 'function') {
		const Component = node.type as (
			props: unknown,
		) => ReactNode | Promise<ReactNode>
		await resolveServerTree(await Component(node.props))
	} else {
		await resolveServerTree(node.props.children)
	}
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
		mocks.getLessonVideoPlaybackResource.mockResolvedValue({
			id: 'video-1',
			muxPlaybackId: 'playback-1',
			chapters: [],
		})
		mocks.getPlaybackPositionForResource.mockResolvedValue(42)
		mocks.player.mockReturnValue(null)
		mocks.overlay.mockReturnValue(null)
		mocks.controls.mockReturnValue(null)
	})

	it.each([
		['paid', { canViewWorkshop: true }],
		['free', { canViewWorkshop: false }],
		['team seat', { canViewWorkshop: true, canInviteTeam: true }],
	])(
		'renders %s playback and completion boundaries without commerce',
		async (_, flags) => {
			mocks.getAbilityForResource.mockResolvedValue({
				...baseAbility,
				...flags,
			})
			await resolveServerTree(await renderLessonPage())

			expect(mocks.commerce).not.toHaveBeenCalled()
			expect(mocks.getLessonVideoPlaybackResource).toHaveBeenCalledWith(
				lesson.id,
			)
			expect(mocks.player).toHaveBeenCalledOnce()
			expect(mocks.overlay).toHaveBeenCalledOnce()
			expect(mocks.controls).toHaveBeenCalledOnce()
			const playerProps = mocks.player.mock.calls[0]![0]
			const overlayProps = mocks.overlay.mock.calls[0]![0]
			expect(playerProps).toMatchObject({
				muxPlaybackId: 'playback-1',
				resource: lesson,
				moduleSlug: 'workshop-1',
			})
			expect(await playerProps.playbackPositionLoader).toBe(42)
			expect(overlayProps).toMatchObject({
				resource: lesson,
				workshop,
				moduleType: 'workshop',
			})
			expect(overlayProps).not.toHaveProperty('pricingProps')
			expect(await overlayProps.abilityLoader).toMatchObject({
				canViewLesson: true,
			})
		},
	)

	it.each([
		['denied', {}],
		['revoked', { canViewWorkshop: false }],
		['region restricted', { isRegionRestricted: true }],
		['unclaimed team seat', { canInviteTeam: true }],
	])('redirects %s before protected work or commerce', async (_, flags) => {
		mocks.getAbilityForResource.mockResolvedValue({
			...baseAbility,
			...flags,
			canViewLesson: false,
		})
		await expect(renderLessonPage()).rejects.toThrow('NEXT_REDIRECT')
		expect(mocks.redirect).toHaveBeenCalledWith('/workshops/workshop-1')
		expect(mocks.getAiCodingDictionary).not.toHaveBeenCalled()
		expect(mocks.compileMDX).not.toHaveBeenCalled()
		expect(mocks.getLessonVideoPlaybackResource).not.toHaveBeenCalled()
		expect(mocks.getPlaybackPositionForResource).not.toHaveBeenCalled()
		expect(mocks.commerce).not.toHaveBeenCalled()
		expect(mocks.player).not.toHaveBeenCalled()
	})

	it('waits for authorization before starting protected work', async () => {
		let deny!: (ability: typeof baseAbility) => void
		mocks.getAbilityForResource.mockReturnValue(
			new Promise<typeof baseAbility>((resolve) => {
				deny = resolve
			}),
		)
		const page = renderLessonPage()
		await Promise.resolve()
		expect(mocks.getAiCodingDictionary).not.toHaveBeenCalled()
		expect(mocks.compileMDX).not.toHaveBeenCalled()
		expect(mocks.getLessonVideoPlaybackResource).not.toHaveBeenCalled()
		expect(mocks.commerce).not.toHaveBeenCalled()
		deny({ ...baseAbility, canViewLesson: false })
		await expect(page).rejects.toThrow('NEXT_REDIRECT')
	})

	it('fails closed when authorization fails', async () => {
		mocks.getAbilityForResource.mockRejectedValue(
			new Error('ability unavailable'),
		)
		await expect(renderLessonPage()).rejects.toThrow('ability unavailable')
		expect(mocks.getAiCodingDictionary).not.toHaveBeenCalled()
		expect(mocks.getLessonVideoPlaybackResource).not.toHaveBeenCalled()
		expect(mocks.commerce).not.toHaveBeenCalled()
	})

	it('does not load commerce or mount a player when an authorized lesson has no playback', async () => {
		mocks.getAbilityForResource.mockResolvedValue(baseAbility)
		mocks.getLessonVideoPlaybackResource.mockResolvedValue(null)
		await resolveServerTree(await renderLessonPage())
		expect(mocks.commerce).not.toHaveBeenCalled()
		expect(mocks.player).not.toHaveBeenCalled()
		expect(mocks.controls).toHaveBeenCalledOnce()
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
