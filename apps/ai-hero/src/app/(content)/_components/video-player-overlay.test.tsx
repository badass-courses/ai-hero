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
	invalidate: vi.fn(),
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
			certificate: { cohortEligibility: { invalidate: mocks.invalidate } },
		}),
	},
}))
vi.mock('@coursebuilder/ui/hooks/use-video-player-overlay', () => ({
	useVideoPlayerOverlay: mocks.overlay,
}))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({
		children,
		onClick,
		disabled,
	}: React.ComponentProps<'button'> & { asChild?: boolean }) => (
		<button onClick={onClick} disabled={disabled}>
			{children}
		</button>
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
}))
vi.mock('@/utils/get-adjacent-workshop-resources', () => ({
	getAdjacentWorkshopResources: () => ({
		nextResource: null,
		prevResource: null,
	}),
}))
vi.mock('react-rewards', () => ({
	useReward: () => ({ reward: vi.fn(), isAnimating: false }),
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

import VideoPlayerOverlay from './video-player-overlay'

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
const nextLessonAction = (playerRef: { current: unknown } = { current: null }) => ({
	type: 'COMPLETED',
	playerRef,
	isModuleComplete: false,
	nextResource: {
		id: 'lesson-2',
		type: 'lesson',
		fields: { title: 'Next lesson', slug: 'lesson-2' },
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
				abilityLoader={Promise.resolve({}) as Props['abilityLoader']}
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
			expect(html).toContain(
				kind === 'signed out' ? 'Continue' : 'Complete &amp; Continue',
			)
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
		})
		expect(mocks.push).toHaveBeenCalledWith('/workshops/test/lesson-2')
		// The write is dispatched first, so the navigation overtakes it.
		expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.push.mock.invocationCallOrder[0]!,
		)
		// The card stays up through the navigation.
		expect(container.innerHTML).toContain('Next lesson')
	})

	it('completes the workshop in the background, then rechecks the cohort certificate', async () => {
		let finishWrite!: () => void
		mocks.complete.mockReturnValue(
			new Promise<void>((resolve) => {
				finishWrite = resolve
			}),
		)
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
		expect(mocks.complete).toHaveBeenCalledWith(
			expect.objectContaining({ resourceId: 'lesson-1' }),
		)
		expect(mocks.invalidate).not.toHaveBeenCalled()
		await act(async () => finishWrite())
		expect(mocks.invalidate).toHaveBeenCalledOnce()

		await act(async () => button('Replay').click())
		expect(play).toHaveBeenCalledOnce()
		await act(async () => button('Dismiss').click())
		expect(dispatch).toHaveBeenCalledWith({ type: 'HIDDEN' })
	})
})
