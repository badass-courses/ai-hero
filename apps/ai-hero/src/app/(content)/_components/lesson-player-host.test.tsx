// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	mux: vi.fn(),
	chip: vi.fn(),
	dispatch: vi.fn(),
	save: vi.fn(() => Promise.resolve(null)),
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
	useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/image', () => ({ default: () => null }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }))
vi.mock('@/trpc/react', () => ({
	api: {
		useUtils: () => ({
			client: {
				progress: {
					setPlaybackPosition: { mutate: mocks.save },
					setCompleted: { mutate: mocks.complete },
				},
			},
			certificate: { cohortEligibility: { invalidate: vi.fn() } },
		}),
	},
}))
vi.mock('@coursebuilder/ui/hooks/use-video-player-overlay', () => ({
	useVideoPlayerOverlay: () => ({ dispatch: mocks.dispatch }),
	VideoPlayerOverlayProvider: ({ children }: { children: ReactNode }) =>
		children,
}))
vi.mock('@/components/player/player-gesture-shell', () => ({
	PlayerGestureShell: ({
		children,
		overlay,
	}: {
		children: ReactNode
		overlay: ReactNode
	}) => (
		<div data-shell="">
			{children}
			{overlay}
		</div>
	),
}))
vi.mock('@/components/player/resume-chip', () => ({
	ResumeChip: (props: { resumedAt: number | null }) => {
		mocks.chip(props.resumedAt)
		return null
	},
}))
vi.mock('@/components/player-skeleton', () => ({
	PlayerContainerSkeleton: () => <div data-skeleton="" />,
}))
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
vi.mock('@/utils/get-adjacent-workshop-resources', () => ({
	getAdjacentWorkshopResources: () => ({
		nextResource: null,
		prevResource: null,
	}),
}))
vi.mock('../workshops/_components/workshop-navigation-provider', () => ({
	useWorkshopNavigation: () => null,
}))
vi.mock('./module-progress-provider', () => ({
	useModuleProgress: () => ({
		moduleProgress: null,
		addLessonProgress: vi.fn(),
		removeLessonProgress: vi.fn(),
	}),
}))
vi.mock('./autoplay-toggle', () => ({ AutoPlayToggle: () => null }))
vi.mock('./video-player-overlay', () => ({ default: () => null }))

import { LessonPlayerHost, LessonVideoSource, type LessonVideo } from './lesson-player-host'

// The host remembers positions for the whole tab, so each test gets its own
// lesson ids.
let run = 0

function video(name: string, savedPosition: number | null = null): LessonVideo {
	const id = `${name}-${run}`
	return {
		resource: {
			id,
			type: 'lesson',
			fields: { slug: id, title: id },
			resources: [],
		} as unknown as LessonVideo['resource'],
		muxPlaybackId: `playback-${name}`,
		chapters: null,
		savedPosition,
		moduleSlug: 'workshop',
		thumbnailUrl: null,
	}
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(...videos: (LessonVideo | null)[]) {
	await act(async () => {
		root.render(
			<LessonPlayerHost>
				{videos.map((v, i) => (
					<LessonVideoSource key={i} video={v} />
				))}
			</LessonPlayerHost>,
		)
	})
}

/** The props the player got on its latest render. */
function player() {
	return mocks.mux.mock.lastCall![0] as Record<
		string,
		(event?: unknown) => void
	> & { playbackId: string }
}

async function fire(
	name: 'onLoadedMetadata' | 'onTimeUpdate' | 'onPause' | 'onEnded',
	currentTime?: number,
) {
	if (currentTime !== undefined) mocks.media.currentTime = currentTime
	await act(async () => player()[name]!({ target: mocks.media }))
}

const writes = () =>
	(mocks.save.mock.calls as unknown as [{ resourceId: string; positionSeconds: number }][]).map(
		([input]) => [input.resourceId.replace(`-${run}`, ''), input.positionSeconds],
	)

describe('LessonPlayerHost', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1))
		run++
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		mocks.media.currentTime = 0
		container = document.createElement('div')
		document.body.append(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		vi.restoreAllMocks()
	})

	it('plays the last registration', async () => {
		await render(video('a'), video('b'))
		expect(player().playbackId).toBe('playback-b')

		await render(video('c'))
		expect(player().playbackId).toBe('playback-c')
	})

	it('passes signed tokens to Mux and clears them on a public source swap', async () => {
		const tokens = { playback: 'v-token', thumbnail: 't-token', storyboard: 's-token' }
		await render({ ...video('signed'), tokens })
		expect(player().tokens).toEqual(tokens)
		await render(video('public'))
		expect(player().tokens).toBeUndefined()
		expect(player().playbackId).toBe('playback-public')
	})

	it('keeps one player across a swap', async () => {
		await render(video('a'))
		const shell = container.querySelector('[data-shell]')
		await render(video('b'))
		expect(container.querySelector('[data-shell]')).toBe(shell)
	})

	it('renders nothing for a lesson without a video', async () => {
		await render(null)
		expect(mocks.mux).not.toHaveBeenCalled()
		expect(container.querySelector('section')).toBeNull()

		await render(video('a'))
		expect(container.querySelector('section')).not.toBeNull()
		await render(null)
		expect(container.querySelector('section')).toBeNull()
	})

	it('a swap hides the card and drops the resume chip', async () => {
		await render(video('a', 60))
		await fire('onLoadedMetadata')
		expect(mocks.media.currentTime).toBe(60)
		expect(mocks.chip).toHaveBeenLastCalledWith(60)

		mocks.dispatch.mockClear()
		await render(video('b'))
		expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'HIDDEN' })
		expect(mocks.chip).toHaveBeenLastCalledWith(null)
	})

	it('writes no position before the source has metadata', async () => {
		await render(video('a'))
		await fire('onTimeUpdate', 42)
		await fire('onPause', 42)
		expect(mocks.save).not.toHaveBeenCalled()

		await fire('onLoadedMetadata', 0)
		await fire('onPause', 42)
		expect(writes()).toEqual([['a', 42]])

		// The outgoing source still reports 42 until Mux empties it.
		await render(video('b'))
		mocks.save.mockClear()
		await fire('onTimeUpdate', 42)
		await fire('onPause', 42)
		expect(mocks.save).not.toHaveBeenCalled()
	})

	it('saves the outgoing lesson where it was, under its own id', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 100)
		// Inside the 30 s throttle: not written yet.
		await fire('onTimeUpdate', 110)
		expect(writes()).toEqual([['a', 100]])

		await render(video('b'))
		expect(writes()).toEqual([
			['a', 100],
			['a', 110],
		])
	})

	it('throttles periodic saves to 30 seconds', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 10)
		const start = Date.now()
		for (const elapsed of [15_000, 20_000, 29_999]) {
			vi.mocked(Date.now).mockReturnValue(start + elapsed)
			await fire('onTimeUpdate', 10 + elapsed / 1000)
		}
		expect(writes()).toEqual([['a', 10]])

		vi.mocked(Date.now).mockReturnValue(start + 30_000)
		await fire('onTimeUpdate', 40)
		expect(writes()).toEqual([
			['a', 10],
			['a', 40],
		])
	})

	it('forces a pause save inside the interval and restarts the throttle', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 10)
		const start = Date.now()
		vi.mocked(Date.now).mockReturnValue(start + 10_000)
		await fire('onPause', 20.9)
		vi.mocked(Date.now).mockReturnValue(start + 30_000)
		await fire('onTimeUpdate', 40)
		expect(writes()).toEqual([
			['a', 10],
			['a', 20],
		])
		vi.mocked(Date.now).mockReturnValue(start + 40_000)
		await fire('onTimeUpdate', 50)
		expect(writes()).toEqual([
			['a', 10],
			['a', 20],
			['a', 50],
		])
	})

	it.each([
		['pause', true],
		['pause', false],
		['hide', true],
		['hide', false],
		['pagehide', true],
		['pagehide', false],
	] as const)(
		'does not double save at the interval boundary (%s, forced first: %s)',
		async (event, forcedFirst) => {
			await render(video('a'))
			await fire('onLoadedMetadata', 0)
			await fire('onTimeUpdate', 10)
			vi.mocked(Date.now).mockReturnValue(Date.now() + 30_000)
			mocks.media.currentTime = 40.9
			const force = async () => {
				if (event === 'pause') return fire('onPause', 40.9)
				if (event === 'hide') {
					vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
					await act(async () =>
						document.dispatchEvent(new Event('visibilitychange')),
					)
				} else {
					await act(async () => window.dispatchEvent(new Event('pagehide')))
				}
			}
			if (forcedFirst) await force()
			await fire('onTimeUpdate', 40.9)
			if (!forcedFirst) await force()
			expect(writes()).toEqual([
				['a', 10],
				['a', 40],
			])
		},
	)

	it('saves the current position on hide and deduplicates pagehide and pause', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 10)
		// Read the live player rather than the last timeupdate's position.
		mocks.media.currentTime = 17.9
		const visibility = vi.spyOn(document, 'visibilityState', 'get')
		visibility.mockReturnValue('visible')
		await act(async () => document.dispatchEvent(new Event('visibilitychange')))
		expect(writes()).toEqual([['a', 10]])

		visibility.mockReturnValue('hidden')
		await act(async () => document.dispatchEvent(new Event('visibilitychange')))
		await act(async () => window.dispatchEvent(new Event('pagehide')))
		await fire('onPause', 17.9)
		expect(writes()).toEqual([
			['a', 10],
			['a', 17],
		])
	})

	it('saves an exit after metadata even before the first timeupdate', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		mocks.media.currentTime = 3.9
		await act(async () => window.dispatchEvent(new Event('pagehide')))
		expect(writes()).toEqual([['a', 3]])
	})

	it('forces a pagehide save without a preceding visibility event', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 10)
		mocks.media.currentTime = 18.9
		await act(async () => window.dispatchEvent(new Event('pagehide')))
		expect(writes()).toEqual([
			['a', 10],
			['a', 18],
		])
	})

	it('does not save exit events before metadata or after a source ends', async () => {
		await render(video('a'))
		await fire('onTimeUpdate', 42)
		await act(async () => window.dispatchEvent(new Event('pagehide')))
		expect(writes()).toEqual([])
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 10)
		await fire('onEnded', 300)
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
		await act(async () => document.dispatchEvent(new Event('visibilitychange')))
		await act(async () => window.dispatchEvent(new Event('pagehide')))
		expect(writes()).toEqual([
			['a', 10],
			['a', 0],
		])
	})

	it('does not overwrite an ended lesson on swap', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 100)
		await fire('onEnded', 300)
		// No session here, but a cookie-only email-course subscriber is recorded.
		expect(mocks.complete).toHaveBeenCalledWith({
			resourceId: `a-${run}`,
			isCompleted: true,
		})
		await render(video('b'))
		expect(writes()).toEqual([
			['a', 100],
			['a', 0],
		])
	})

	it('resumes from this session on back, over a stale server position', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 100)
		await fire('onTimeUpdate', 110)
		await render(video('b'))

		// The router cache replays A's first visit: no saved position.
		await render(video('a', null))
		await fire('onLoadedMetadata', 0)
		expect(mocks.media.currentTime).toBe(110)
		expect(mocks.chip).toHaveBeenLastCalledWith(110)
	})

	it('saves on leaving the lessons, and resumes there on return', async () => {
		await render(video('a'))
		await fire('onLoadedMetadata', 0)
		await fire('onTimeUpdate', 100)
		await fire('onTimeUpdate', 110)

		// The workshop page: outside (learn), so the host unmounts.
		await act(async () => root.render(<div />))
		expect(writes()).toEqual([
			['a', 100],
			['a', 110],
		])

		await render(video('a', null))
		await fire('onLoadedMetadata', 0)
		expect(mocks.media.currentTime).toBe(110)
	})

	it('holds the place of the player until the host has a source', async () => {
		// What the server renders: the host has nothing yet.
		const { renderToString } = await import('react-dom/server')
		const html = renderToString(
			<LessonPlayerHost>
				<LessonVideoSource video={video('a')} />
			</LessonPlayerHost>,
		)
		expect(html).toContain('data-skeleton')
		expect(
			renderToString(
				<LessonPlayerHost>
					<LessonVideoSource video={null} />
				</LessonPlayerHost>,
			),
		).not.toContain('data-skeleton')

		// Once registered, the player replaces it.
		await render(video('a'))
		expect(container.querySelector('[data-skeleton]')).toBeNull()
		expect(container.querySelectorAll('section')).toHaveLength(1)
	})
})
