// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The host with the real end card and overlay state, for what the card from
// the last lesson does while the swap holds it up.
const mocks = vi.hoisted(() => ({
	mux: vi.fn(),
	push: vi.fn(),
	complete: vi.fn(() => Promise.resolve(null)),
	media: {
		currentTime: 0,
		duration: 300,
		paused: true,
		play: () => Promise.resolve(),
		pause: () => {},
	},
}))

vi.mock('@mux/mux-player-react', async () => {
	const React = await import('react')
	return {
		default: React.forwardRef(function MuxPlayer(
			props: Record<string, unknown>,
			ref,
		) {
			React.useImperativeHandle(ref, () => mocks.media as never)
			mocks.mux(props)
			return null
		}),
	}
})
vi.mock('next/navigation', () => ({
	useRouter: () => ({ push: mocks.push, prefetch: vi.fn() }),
	usePathname: () => '/workshops/workshop/a',
	useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('next/link', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }))
vi.mock('@/trpc/react', () => {
	// Stable, like the real one: the player keys its save queue on it.
	const utils = {
		client: {
			progress: {
				setPlaybackPosition: { mutate: () => Promise.resolve(null) },
				setCompleted: { mutate: mocks.complete },
			},
		},
		certificate: { cohortEligibility: { invalidate: vi.fn() } },
	}
	return { api: { useUtils: () => utils } }
})
vi.mock('@coursebuilder/ui', () => ({
	Button: ({
		children,
		asChild: _asChild,
		...props
	}: React.ComponentProps<'button'> & { asChild?: boolean }) => (
		<button {...props}>{children}</button>
	),
	Progress: () => null,
}))
vi.mock('@/components/player/player-gesture-shell', () => ({
	PlayerGestureShell: ({
		children,
		overlay,
	}: {
		children: ReactNode
		overlay: ReactNode
	}) => (
		<div data-player-gesture-shell="">
			{children}
			{overlay}
		</div>
	),
}))
vi.mock('@/components/player/resume-chip', () => ({ ResumeChip: () => null }))
vi.mock('@/components/player-skeleton', () => ({
	PlayerContainerSkeleton: () => null,
}))
vi.mock('@/components/spinner', () => ({ default: () => null }))
vi.mock('@/components/video-chapters/use-mux-chapters', () => ({
	useMuxChapters: () => {},
}))
vi.mock('@/hooks/use-mux-metadata', () => ({
	useMuxMetadata: (metadata: object) => metadata,
}))
vi.mock('@/hooks/use-mux-player', () => ({
	useMuxPlayer: () => ({
		playerPrefs: { autoplay: false, playbackRate: 1, volume: 1 },
		setPlayerPrefs: vi.fn(),
		setMuxPlayerRef: vi.fn(),
	}),
}))
vi.mock('@/hooks/use-video-quality-pref', () => ({
	useVideoQualityPref: () => () => {},
}))
vi.mock('@/hooks/use-mux-player-prefs', () => ({
	handleTextTrackChange: () => {},
	setPreferredPlaybackRate: () => {},
	setPreferredTextTrack: () => {},
}))
vi.mock('@/lib/mux-player-prefs', () => ({
	muxMinResolutionForPrefs: () => undefined,
}))
vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))
vi.mock('@/lib/content-navigation', () => ({
	findParentLessonForSolution: () => null,
	getModuleCompletionState: () => ({ isModuleComplete: false }),
	flattenNavigationResources: () => lessons,
	isCompletionTrackedResource: () => true,
}))
vi.mock('@/lib/cohort-navigation', () => ({
	getNextCohortWorkshop: () => null,
	isWorkshopAvailable: () => false,
}))
vi.mock('@/utils/get-adjacent-workshop-resources', () => ({
	getAdjacentWorkshopResources: (_: unknown, id: string) => {
		const index = lessons.findIndex((l) => l.id === id)
		return {
			prevResource: lessons[index - 1] ?? null,
			nextResource: lessons[index + 1] ?? null,
		}
	},
}))
vi.mock('../workshops/_components/workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => ({
		id: 'workshop',
		fields: { slug: 'workshop', title: 'Workshop' },
	}),
}))
vi.mock('../workshops/_components/cohort-navigation-provider', () => ({
	useCohortNavigation: () => null,
}))
vi.mock('../workshops/_components/copy-problem-prompt-button', () => ({
	CopyProblemPromptButton: () => null,
}))
vi.mock('@/components/certificates/module-certificate', () => ({
	Root: ({ children }: { children: ReactNode }) => children,
	Trigger: ({ children }: { children: ReactNode }) => (
		<button>{children}</button>
	),
}))
vi.mock('react-rewards', () => ({ useReward: () => ({ reward: vi.fn() }) }))
vi.mock('./cohort-certificate-container', () => ({
	CohortCertificateAction: () => null,
	useCohortCertificateEligibility: () => false,
}))
vi.mock('./module-certificate-container', () => ({
	CertificateDialog: () => null,
}))
vi.mock('./module-progress-provider', () => ({
	useModuleProgress: () => ({
		moduleProgress: null,
		addLessonProgress: vi.fn(),
		removeLessonProgress: vi.fn(),
	}),
}))
vi.mock('./autoplay-toggle', () => ({ AutoPlayToggle: () => null }))

import { MotionGlobalConfig } from 'framer-motion'

import {
	LessonPlayerHost,
	LessonVideoSource,
	type LessonVideo,
} from './lesson-player-host'

// happy-dom cancels native animations with an unhandled AbortError.
MotionGlobalConfig.skipAnimations = true

const lesson = (name: string) =>
	({
		id: name,
		type: 'lesson',
		fields: { slug: name, title: `Lesson ${name}` },
		resources: [
			{ resourceId: `video-${name}`, resource: { type: 'videoResource' } },
		],
	}) as unknown as LessonVideo['resource']
const lessons = ['a', 'b', 'c'].map(lesson)

const video = (index: number): LessonVideo => ({
	resource: lessons[index]!,
	muxPlaybackId: `playback-${index}`,
	chapters: null,
	savedPosition: null,
	moduleSlug: 'workshop',
	thumbnailUrl: null,
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(v: LessonVideo) {
	await act(async () => {
		root.render(
			<LessonPlayerHost>
				<LessonVideoSource video={v} />
			</LessonPlayerHost>,
		)
	})
}

async function fire(name: 'onLoadedMetadata' | 'onEnded') {
	const props = mocks.mux.mock.lastCall![0] as Record<
		string,
		(event: unknown) => void
	>
	await act(async () => props[name]!({ target: mocks.media }))
}

const card = () =>
	container.querySelector<HTMLElement>('[data-player-gesture-shell] [aria-live]')
const continueButton = () =>
	container.querySelector<HTMLButtonElement>('[data-end-card-continue]')

describe('the end card during the swap hold', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		// The arrival poster never decodes: the hold lasts the whole test.
		vi.stubGlobal(
			'Image',
			class {
				src = ''
				decode = () => new Promise(() => {})
			},
		)
		mocks.media.currentTime = 0
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		vi.unstubAllGlobals()
	})

	it('stays the last lesson’s card, and does nothing', async () => {
		await render(video(0))
		await fire('onLoadedMetadata')
		await fire('onEnded')
		expect(card()?.textContent).toContain('Lesson b')
		expect(mocks.complete).toHaveBeenCalledWith({
			resourceId: 'a',
			isCompleted: true,
		})

		// Continue went to B; the card holds until B's poster decodes.
		mocks.complete.mockClear()
		await render(video(1))
		expect(card()?.textContent).toContain('Lesson b')

		await act(async () => continueButton()!.click())
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
			)
		})
		expect(mocks.complete).not.toHaveBeenCalled()
		expect(mocks.push).not.toHaveBeenCalled()
		expect(card()?.inert).toBe(true)
	})

	it('holds the card on a way back to the first lesson too', async () => {
		const poster = () => (mocks.mux.mock.lastCall![0] as { poster?: string }).poster
		await render(video(0))
		expect(poster()).toBeUndefined()
		await render(video(1))
		expect(poster()).toContain('video-b')

		await render(video(0))
		expect(poster()).toContain('video-a')
	})
})
