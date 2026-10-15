// @vitest-environment happy-dom
import React, { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	overlay: vi.fn(),
	session: vi.fn(),
	progress: vi.fn(),
	navigation: vi.fn(),
	push: vi.fn(),
	complete: vi.fn(),
	setCompleted: vi.fn(),
	reward: vi.fn(),
	reduceMotion: vi.fn(() => false),
}))
vi.mock('framer-motion', async (importOriginal) => ({
	...(await importOriginal<typeof import('framer-motion')>()),
	useReducedMotion: mocks.reduceMotion,
}))
vi.mock('next/link', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('next/navigation', () => ({
	usePathname: () => '/workshops/test/lesson-1',
	useRouter: () => ({ push: mocks.push }),
}))
vi.mock('next-auth/react', () => ({ useSession: mocks.session }))
vi.mock('@/trpc/react', () => ({
	api: {
		useUtils: () => ({
			client: { progress: { setCompleted: { mutate: mocks.setCompleted } } },
		}),
	},
}))
vi.mock('@coursebuilder/ui/hooks/use-video-player-overlay', () => ({
	useVideoPlayerOverlay: mocks.overlay,
}))
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
vi.mock('@coursebuilder/ui/utils/cn', () => ({
	cn: (...values: unknown[]) =>
		values.filter((v) => typeof v === 'string').join(' '),
}))
vi.mock('@coursebuilder/utils/resource-paths', () => ({
	getResourcePath: () => '/next',
}))
vi.mock(
	'@/app/(content)/workshops/_components/cohort-navigation-provider',
	() => ({ useCohortNavigation: () => null }),
)
vi.mock(
	'@/app/(content)/workshops/_components/workshop-navigation-provider',
	() => ({ useWorkshopNavigation: mocks.navigation }),
)
vi.mock('@/components/spinner', () => ({
	default: () => <span>Navigating</span>,
}))
vi.mock('@/lib/cohort-navigation', () => ({
	getNextCohortWorkshop: () => null,
	isWorkshopAvailable: () => false,
}))
vi.mock('@/lib/content-navigation', () => ({
	findParentLessonForSolution: () => null,
	getModuleCompletionState: () => ({ isModuleComplete: false }),
	flattenNavigationResources: () => [{ id: 'lesson-1' }, { id: 'lesson-2' }],
	isCompletionTrackedResource: () => true,
}))
vi.mock('@/utils/get-adjacent-workshop-resources', () => ({
	getAdjacentWorkshopResources: () => ({
		nextResource: null,
		prevResource: null,
	}),
}))
vi.mock('react-rewards', () => ({
	useReward: () => ({ reward: mocks.reward, isAnimating: false }),
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
vi.mock('./complete-lesson-in-background', () => ({
	completeLessonInBackground: mocks.complete,
}))
vi.mock('./cohort-certificate-container', () => ({
	CohortCertificateAction: () => null,
	useCohortCertificateEligibility: () => false,
}))
vi.mock('./module-certificate-container', () => ({
	CertificateDialog: () => null,
}))
vi.mock('./module-progress-provider', () => ({
	useModuleProgress: mocks.progress,
}))

import { MotionGlobalConfig } from 'framer-motion'

import VideoPlayerOverlay from './video-player-overlay'

// happy-dom cancels native animations with an unhandled AbortError.
MotionGlobalConfig.skipAnimations = true

type Props = ComponentProps<typeof VideoPlayerOverlay>
const resource: Props['resource'] = {
	id: 'lesson-1',
	type: 'lesson',
	fields: { slug: 'lesson-1', title: 'Lesson' },
	createdById: 'author-1',
	createdAt: null,
	updatedAt: null,
	deletedAt: null,
	resources: [],
	organizationId: null,
	createdByOrganizationMembershipId: null,
}
const nextLessonAction = (
	playerRef: { current: unknown } = { current: null },
	autoAdvance = false,
) => ({
	type: 'COMPLETED',
	playerRef,
	isModuleComplete: false,
	autoAdvance,
	nextResource: {
		id: 'lesson-2',
		type: 'lesson',
		fields: { title: 'Next lesson', slug: 'lesson-2' },
		resources: [{ resourceId: 'video-2', resource: { type: 'videoResource' } }],
	},
})
const progress = {
	completedLessons: [],
	percentCompleted: 50,
	completedLessonsCount: 1,
	totalLessonsCount: 2,
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function renderOverlay() {
	await act(async () => {
		root.render(
			<VideoPlayerOverlay
				resource={resource}
				moduleType="workshop"
				moduleSlug="test"
			/>,
		)
	})
	return container
}

function button(name: string | RegExp) {
	const match = [...container.querySelectorAll('button')].find((b) =>
		typeof name === 'string'
			? b.textContent?.trim() === name
			: name.test(b.textContent ?? ''),
	)
	if (!match) throw new Error(`no button ${name}`)
	return match
}

describe('VideoPlayerOverlay', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
		mocks.overlay.mockReturnValue({
			state: { action: { type: 'HIDDEN' } },
			dispatch: vi.fn(),
		})
		mocks.session.mockReturnValue({ data: { user: { id: 'user-1' } } })
		mocks.navigation.mockReturnValue({
			id: 'workshop-1',
			fields: { slug: 'test', title: 'Workshop' },
		})
		mocks.progress.mockReturnValue({
			moduleProgress: progress,
			addLessonProgress: vi.fn(),
			removeLessonProgress: vi.fn(),
		})
		mocks.complete.mockReturnValue(Promise.resolve())
		mocks.reduceMotion.mockReturnValue(false)
	})

	afterEach(async () => {
		await act(async () => root.unmount())
		container.remove()
		vi.unstubAllGlobals()
	})

	it.each(['HIDDEN', 'LOADING', undefined])(
		'draws nothing outside completion (%s)',
		async (type) => {
			mocks.overlay.mockReturnValue({
				state: { action: type ? { type } : undefined },
				dispatch: vi.fn(),
			})
			expect((await renderOverlay()).innerHTML).toBe('')
		},
	)

	it.each(['member', 'signed out'])(
		'shows the next lesson card to a %s viewer',
		async (kind) => {
			mocks.overlay.mockReturnValue({
				state: { action: nextLessonAction() },
				dispatch: vi.fn(),
			})
			if (kind === 'signed out') mocks.session.mockReturnValue({ data: null })
			const html = (await renderOverlay()).innerHTML
			expect(html).toContain('Next lesson')
			expect(html).toContain('Replay')
			expect(html).toContain('Dismiss')
			// The lesson completed when the video ended.
			expect(html).toContain('Continue')
			expect(html).not.toContain('Complete')
			expect(html).toContain(kind === 'signed out' ? 'Log in' : 'completed')
		},
	)

	it('navigates on Continue without waiting for the progress write', async () => {
		// A write that never settles must not hold the navigation (the hang).
		mocks.complete.mockReturnValue(new Promise(() => {}))
		const removeLessonProgress = vi.fn()
		const addLessonProgress = vi.fn()
		mocks.progress.mockReturnValue({
			moduleProgress: progress,
			addLessonProgress,
			removeLessonProgress,
		})
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch: vi.fn(),
		})
		await renderOverlay()
		await act(async () => button(/Continue/).click())

		expect(mocks.complete).toHaveBeenCalledWith({
			resourceId: 'lesson-1',
			moduleProgress: progress,
			addLessonProgress,
			removeLessonProgress,
			setCompleted: mocks.setCompleted,
		})
		expect(mocks.push).toHaveBeenCalledWith('/workshops/test/lesson-2')
		// The write is dispatched first, so the navigation overtakes it.
		expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.push.mock.invocationCallOrder[0]!,
		)
		// The card stays up through the navigation.
		expect(container.innerHTML).toContain('Next lesson')
	})

	it('records nothing on Continue for a signed-out viewer', async () => {
		mocks.session.mockReturnValue({ data: null })
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch: vi.fn(),
		})
		await renderOverlay()
		await act(async () => button(/Continue/).click())
		expect(mocks.complete).not.toHaveBeenCalled()
		expect(mocks.push).toHaveBeenCalledWith('/workshops/test/lesson-2')
	})

	it('focuses Continue and answers Shift+N, Escape and Space', async () => {
		const dispatch = vi.fn()
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch,
		})
		await renderOverlay()
		expect(document.activeElement).toBe(button(/Continue/))

		const press = (key: string, init: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent('keydown', {
				key,
				bubbles: true,
				cancelable: true,
				...init,
			})
			document.body.dispatchEvent(event)
			return event
		}
		// Space on the page must not reach the shell's play/pause.
		expect(press(' ').defaultPrevented).toBe(true)
		expect(press('k').defaultPrevented).toBe(true)
		await act(async () => void press('N', { shiftKey: true }))
		expect(mocks.push).toHaveBeenCalledWith('/workshops/test/lesson-2')
		press('Escape')
		expect(dispatch).toHaveBeenCalledWith({ type: 'HIDDEN' })
	})

	it('previews the next lesson with its thumbnail and place', async () => {
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch: vi.fn(),
		})
		const html = (await renderOverlay()).innerHTML
		expect(html).toContain('Lesson 2 of 2')
		expect(container.querySelector('img')?.getAttribute('src')).toBe(
			'/api/thumbnails?videoResourceId=video-2',
		)
	})

	describe('with autoplay', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		it('counts down and moves on at zero', async () => {
			mocks.overlay.mockReturnValue({
				state: { action: nextLessonAction(undefined, true) },
				dispatch: vi.fn(),
			})
			await renderOverlay()
			expect(container.textContent).toContain('Up next in 5')
			expect(button(/Play now/)).toBe(document.activeElement)
			expect(container.querySelector('.origin-left')).not.toBeNull()

			await act(async () => vi.advanceTimersByTime(2_050))
			expect(container.textContent).toContain('Up next in 3')
			expect(mocks.push).not.toHaveBeenCalled()

			await act(async () => vi.advanceTimersByTime(3_000))
			expect(mocks.push).toHaveBeenCalledOnce()
			expect(mocks.push).toHaveBeenCalledWith('/workshops/test/lesson-2')
		})

		it('becomes the normal card on Cancel', async () => {
			const dispatch = vi.fn()
			const action = nextLessonAction(undefined, true)
			mocks.overlay.mockReturnValue({ state: { action }, dispatch })
			await renderOverlay()
			await act(async () => button('Cancel').click())
			expect(dispatch).toHaveBeenCalledWith({ ...action, autoAdvance: false })
		})

		it('shows only the number under reduced motion', async () => {
			mocks.reduceMotion.mockReturnValue(true)
			mocks.overlay.mockReturnValue({
				state: { action: nextLessonAction(undefined, true) },
				dispatch: vi.fn(),
			})
			await renderOverlay()
			expect(container.textContent).toContain('Up next in 5')
			expect(container.querySelector('.origin-left')).toBeNull()
		})
	})

	it.each([
		['pointerdown', false],
		['keydown', true],
	])('draws the focus ring only after keyboard input (%s)', async (input, ring) => {
		const focus = vi.spyOn(HTMLElement.prototype, 'focus')
		window.dispatchEvent(new Event(input))
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch: vi.fn(),
		})
		await renderOverlay()
		expect(focus).toHaveBeenCalledWith({
			preventScroll: true,
			focusVisible: ring,
		})
		focus.mockRestore()
	})

	it('leaves focus where the learner put it outside the player', async () => {
		const input = document.createElement('input')
		document.body.append(input)
		input.focus()
		mocks.overlay.mockReturnValue({
			state: { action: nextLessonAction() },
			dispatch: vi.fn(),
		})
		await renderOverlay()
		expect(document.activeElement).toBe(input)
		input.remove()
	})

	it.each([
		[false, 1],
		[true, 0],
	])(
		'celebrates the finished workshop (reduced motion %s) and dismisses',
		async (reduced, confetti) => {
			mocks.reduceMotion.mockReturnValue(reduced)
			const play = vi.fn()
			const dispatch = vi.fn()
			mocks.overlay.mockReturnValue({
				state: {
					action: {
						type: 'COMPLETED',
						isModuleComplete: true,
						playerRef: { current: { play } },
					},
				},
				dispatch,
			})
			const html = (await renderOverlay()).innerHTML
			expect(html).toContain('Great job!')
			expect(html).toContain('Get your certificate')
			// The ended handler wrote the completion; the card does not.
			expect(mocks.complete).not.toHaveBeenCalled()
			expect(mocks.reward).toHaveBeenCalledTimes(confetti)

			await act(async () => button('Replay').click())
			expect(play).toHaveBeenCalledOnce()
			await act(async () => button('Dismiss').click())
			expect(dispatch).toHaveBeenCalledWith({ type: 'HIDDEN' })
		},
	)
})
