import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	gate: vi.fn(),
	mint: vi.fn(),
	info: vi.fn(async () => {}),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('@/utils/get-current-ability-rules', () => ({
	getAbilityForResource: mocks.gate,
}))
vi.mock('./c5-signed-playback-inventory', () => ({
	c5SignedPlaybackInventoryQuery: () => 'inventory-query',
}))
vi.mock('./signed-playback', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./signed-playback')>()
	return { ...actual, selectLessonPlayback: mocks.mint }
})
import { getSignedLessonPlayback } from './signed-lesson-playback'
const input = {
	lessonId: 'lesson-fixture',
	workshopId: 'workshop-fixture',
	moduleSlug: 'workshop-slug',
	lessonSlug: 'lesson-slug',
	video: {
		id: 'video-fixture',
		muxPlaybackId: 'public-fixture',
		muxSignedPlaybackId: 'signed-fixture',
	},
}

describe('server signed lesson playback boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('AIH_SIGNED_PLAYBACK_RESOURCES', 'cohort-xdy1m')
		mocks.gate.mockResolvedValue({ canViewLesson: true })
		mocks.execute.mockResolvedValue({
			rows: [
				{
					resourceId: input.video.id,
					lessonId: input.lessonId,
					workshopId: input.workshopId,
				},
			],
		})
		mocks.mint.mockResolvedValue({ muxPlaybackId: 'signed-fixture' })
	})

	it('reuses the current server lesson gate before checking cohort scope', async () => {
		await getSignedLessonPlayback(input)
		expect(mocks.gate).toHaveBeenCalledWith(input.lessonSlug, input.moduleSlug)
		expect(mocks.mint).toHaveBeenCalledWith(
			expect.objectContaining({ canView: true, inPilot: true }),
		)
	})

	it('never queries scope or mints for a denied viewer', async () => {
		mocks.gate.mockResolvedValue({ canViewLesson: false })
		expect(await getSignedLessonPlayback(input)).toBeNull()
		expect(mocks.execute).not.toHaveBeenCalled()
		expect(mocks.mint).not.toHaveBeenCalled()
	})

	it.each(['lessonId', 'workshopId', 'resourceId'])(
		'does not treat an unrelated %s as pilot membership',
		async (key) => {
			mocks.execute.mockResolvedValue({
				rows: [
					{
						resourceId: input.video.id,
						lessonId: input.lessonId,
						workshopId: input.workshopId,
						[key]: 'unrelated',
					},
				],
			})
			await getSignedLessonPlayback(input)
			expect(mocks.mint).toHaveBeenCalledWith(
				expect.objectContaining({ inPilot: false }),
			)
		},
	)

	it('keeps the flag-off path free of new lookups or signing', async () => {
		vi.stubEnv('AIH_SIGNED_PLAYBACK_RESOURCES', '')
		expect(await getSignedLessonPlayback(input)).toEqual({
			muxPlaybackId: 'public-fixture',
		})
		expect(mocks.execute).not.toHaveBeenCalled()
		expect(mocks.mint).not.toHaveBeenCalled()
	})

	it('falls back if the cohort lookup fails, without logging its error', async () => {
		mocks.execute.mockRejectedValue(new Error('private database details'))
		expect(await getSignedLessonPlayback(input)).toEqual({
			muxPlaybackId: 'public-fixture',
		})
		expect(mocks.info).toHaveBeenCalledWith('video.signed_playback.fallback', {
			resourceId: input.video.id,
			reason: 'scope_lookup_failed',
		})
	})
})
