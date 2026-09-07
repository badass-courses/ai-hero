import React, { type ComponentProps, type ReactNode } from 'react'
import { PassThrough } from 'node:stream'
import { renderToPipeableStream } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	overlay: vi.fn(),
	formattedPrice: vi.fn(),
	session: vi.fn(),
	progress: vi.fn(),
	navigation: vi.fn(),
	button: vi.fn(),
}))
vi.mock('next/link', () => ({
	default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('next/navigation', () => ({
	usePathname: () => '/workshops/test/lesson',
	useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('next-auth/react', () => ({ useSession: mocks.session }))
vi.mock('@/trpc/react', () => ({
	api: {
		pricing: { formatted: { useQuery: mocks.formattedPrice } },
		useUtils: () => ({}),
	},
}))
vi.mock('@coursebuilder/ui/hooks/use-video-player-overlay', () => ({
	useVideoPlayerOverlay: mocks.overlay,
}))
vi.mock('@coursebuilder/ui', () => ({
	Button: (props: React.ComponentProps<'button'>) => {
		mocks.button(props)
		return <button>{props.children}</button>
	},
	Progress: () => null,
	useToast: () => ({ toast: vi.fn() }),
}))
vi.mock('@coursebuilder/ui/utils/cn', () => ({
	cn: (...values: unknown[]) =>
		values.filter((v) => typeof v === 'string').join(' '),
}))
vi.mock('@coursebuilder/commerce-next/team/invite-team', () => ({
	default: () => <div>Team invitations</div>,
}))
vi.mock('@coursebuilder/core/pricing/build-stripe-checkout-path', () => ({
	buildStripeCheckoutPath: () => '/checkout',
}))
vi.mock('@coursebuilder/core/utils/format-usd', () => ({
	formatUsd: () => ({ dollars: '10', cents: '00' }),
}))
vi.mock('@coursebuilder/utils/resource-paths', () => ({
	getResourcePath: () => '/next',
}))
vi.mock('@/app/(content)/tutorials/actions', () => ({
	revalidateTutorialLesson: vi.fn(),
}))
vi.mock('../actions', () => ({ revalidateModuleLesson: vi.fn() }))
vi.mock(
	'@/app/(content)/workshops/_components/cohort-navigation-provider',
	() => ({ useCohortNavigation: () => null }),
)
vi.mock(
	'@/app/(content)/workshops/_components/workshop-navigation-provider',
	() => ({ useWorkshopNavigation: mocks.navigation }),
)
vi.mock('@/components/cld-image', () => ({ CldImage: () => null }))
vi.mock('@/components/spinner', () => ({
	default: () => <span>Loading player</span>,
}))
vi.mock('@/components/video-block-newsletter-cta', () => ({
	VideoBlockNewsletterCta: () => null,
}))
vi.mock('@/lib/cohort-navigation', () => ({
	getNextCohortWorkshop: () => null,
	isWorkshopAvailable: () => false,
}))
vi.mock('@/lib/content-navigation', () => ({
	findParentLessonForSolution: () => null,
	getModuleCompletionState: () => ({ isModuleComplete: false }),
}))
vi.mock('@/lib/progress', () => ({ setProgressForResource: vi.fn() }))
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
vi.mock('../workshops/_components/video-overlay-pricing-widget', () => ({
	VideoOverlayWorkshopPricing: () => <div>Workshop purchase</div>,
}))
vi.mock('@/components/certificates/module-certificate', () => ({
	Root: ({ children }: { children: ReactNode }) => children,
	Trigger: ({ children }: { children: ReactNode }) => (
		<button>{children}</button>
	),
	Content: () => null,
}))
vi.mock('./authed-video-player', () => ({ handleSetLessonComplete: vi.fn() }))
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
const allowed = {
	canViewLesson: true,
	canViewWorkshop: true,
	canInviteTeam: false,
	isRegionRestricted: false,
	isPendingOpenAccess: false,
	canCreate: false,
}
const pricing = {
	product: { id: 'product-1' },
	purchases: [
		{
			id: 'purchase-1',
			productId: 'product-1',
			country: 'US',
			bulkCoupon: { maxUses: 5, usedCount: 0 },
		},
	],
} as Props['pricingProps']

// Real React streaming SSR resolves use(abilityLoader) and renders the actual
// overlay and completion components. Provider/UI adapters stay synthetic.
function renderOverlay(
	ability = allowed,
	pricingProps?: Props['pricingProps'],
) {
	return new Promise<string>((resolve, reject) => {
		const output = new PassThrough()
		let html = ''
		output.on('data', (chunk) => {
			html += chunk.toString()
		})
		output.on('end', () => resolve(html))
		const stream = renderToPipeableStream(
			<VideoPlayerOverlay
				resource={resource}
				abilityLoader={Promise.resolve(ability) as Props['abilityLoader']}
				moduleType="workshop"
				moduleSlug="test"
				workshop={null}
				pricingProps={pricingProps}
			/>,
			{
				onAllReady() {
					stream.pipe(output)
				},
				onError: reject,
			},
		)
	})
}

describe('VideoPlayerOverlay without authorized commerce data', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.overlay.mockReturnValue({
			state: { action: { type: 'HIDDEN' } },
			dispatch: vi.fn(),
		})
		mocks.formattedPrice.mockReturnValue({ status: 'pending' })
		mocks.session.mockReturnValue({ data: { user: { id: 'user-1' } } })
		mocks.navigation.mockReturnValue(null)
		mocks.progress.mockReturnValue({
			moduleProgress: {
				completedLessons: [],
				percentCompleted: 50,
				completedLessonsCount: 1,
				totalLessonsCount: 2,
			},
			addLessonProgress: vi.fn(),
		})
	})

	it('keeps authorized hidden and loading states without enabling pricing', async () => {
		expect(await renderOverlay()).toBe('')
		mocks.overlay.mockReturnValue({
			state: { action: { type: 'LOADING' } },
			dispatch: vi.fn(),
		})
		expect(await renderOverlay()).toContain('Loading player')
		for (const [, options] of mocks.formattedPrice.mock.calls)
			expect(options.enabled).toBe(false)
	})

	it.each(['paid', 'free', 'team'])(
		'retains %s completion controls without pricing',
		async (kind) => {
			mocks.overlay.mockReturnValue({
				state: {
					action: {
						type: 'COMPLETED',
						playerRef: { current: null },
						isModuleComplete: false,
						nextResource: {
							id: 'lesson-2',
							type: 'lesson',
							fields: { title: 'Next lesson', slug: 'lesson-2' },
						},
					},
				},
				dispatch: vi.fn(),
			})
			if (kind === 'free') mocks.session.mockReturnValue({ data: null })
			const html = await renderOverlay({
				...allowed,
				canViewWorkshop: kind !== 'free',
				canInviteTeam: kind === 'team',
			})
			expect(html).toContain('Next lesson')
			expect(html).toContain('Replay')
			expect(html).toContain('Dismiss')
			expect(html).toContain(
				kind === 'free' ? 'Continue' : 'Complete &amp; Continue',
			)
			expect(html).not.toContain('Workshop purchase')
			for (const [, options] of mocks.formattedPrice.mock.calls)
				expect(options.enabled).toBe(false)
		},
	)

	it('retains final completion, certificate, replay and dismiss without pricing', async () => {
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
		const html = await renderOverlay()
		expect(html).toContain('Great job!')
		expect(html).toContain('Get your certificate')
		const buttons = mocks.button.mock.calls.map(([props]) => props)
		buttons.find((props) => props.children === 'Replay').onClick()
		expect(play).toHaveBeenCalledOnce()
		// Dismiss has an sr-only span and icon, unlike the replay text button.
		buttons.find((props) => Array.isArray(props.children)).onClick()
		expect(dispatch).toHaveBeenCalledWith({ type: 'HIDDEN' })
		for (const [, options] of mocks.formattedPrice.mock.calls)
			expect(options.enabled).toBe(false)
	})

	it('retains denied purchase UI for other callers that supply pricing', async () => {
		expect(
			await renderOverlay({ ...allowed, canViewLesson: false }, pricing),
		).toContain('Workshop purchase')
	})

	it('retains region upgrade and its enabled pricing query for other callers', async () => {
		const html = await renderOverlay(
			{ ...allowed, canViewLesson: false, isRegionRestricted: true },
			pricing,
		)
		expect(html).toContain('Upgrade to full license')
		expect(mocks.formattedPrice).toHaveBeenCalledWith(
			expect.objectContaining({ productId: 'product-1' }),
			{ enabled: true },
		)
	})

	it('retains the team invitation branch for unclaimed seats on other callers', async () => {
		expect(
			await renderOverlay(
				{ ...allowed, canViewLesson: false, canInviteTeam: true },
				pricing,
			),
		).toContain('Team invitations')
		expect(mocks.formattedPrice.mock.calls[0]?.[1].enabled).toBe(false)
	})
})
