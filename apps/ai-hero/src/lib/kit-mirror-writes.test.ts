import { afterEach, describe, expect, it, vi } from 'vitest'
import { kitMirrorWritesEnabled } from './kit-mirror-writes'
import { projectExistingCrashCoursePurchasers } from './crash-course-purchaser-tag'
import {
	createCrashCoursePurchaserTagger,
	getRequiredKitV4ApiKey,
} from '@/coursebuilder/crash-course-purchaser-kit-v4'
import {
	captureValuePathFinisherFields,
	AIH_FINISHER_SEGMENT_FIELD,
	AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
} from './subscriber-marketing/value-path-finisher-capture'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('AI Hero optional Kit mirrors', () => {
	it.each([undefined, '', 'true', 'on', '1', 'typo'])(
		'keeps writes on for %s',
		(value) => {
			expect(
				kitMirrorWritesEnabled({ AIH_KIT_MIRROR_WRITES_ENABLED: value }),
			).toBe(true)
		},
	)
	it.each(['false', 'off', '0', ' FALSE '])(
		'turns writes off for %s',
		(value) => {
			expect(
				kitMirrorWritesEnabled({ AIH_KIT_MIRROR_WRITES_ENABLED: value }),
			).toBe(false)
		},
	)

	it('makes no purchaser-script lookup, field or tag call, even with allowWrite', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		const getSubscriberByEmail = vi.fn()
		const updateSubscriberFields = vi.fn()
		const tagExistingSubscriber = vi.fn()
		const result = await projectExistingCrashCoursePurchasers({
			candidates: [
				{ email: 'buyer@example.test', purchasedAt: new Date('2026-10-01') },
			],
			allowWrite: true,
			provider: { getSubscriberByEmail, updateSubscriberFields },
			tagExistingSubscriber,
		})
		expect(result.mode).toBe('mirror-disabled')
		expect(result.counts).toMatchObject({
			uniquePurchasers: 1,
			propertyWrites: 0,
			tagWrites: 0,
		})
		for (const call of [
			getSubscriberByEmail,
			updateSubscriberFields,
			tagExistingSubscriber,
		])
			expect(call).not.toHaveBeenCalled()
	})

	it('guards the v4 tag adapter itself without requiring a credential', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'off')
		vi.stubEnv('CONVERTKIT_V4_API_KEY', '')
		const fetcher = vi.fn()
		await createCrashCoursePurchaserTagger({
			apiKey: getRequiredKitV4ApiKey(),
			fetcher,
		})('123')
		expect(fetcher).not.toHaveBeenCalled()
	})

	it('keeps a master-off finisher dry-run from completing a write intent', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		const result = await captureValuePathFinisherFields({
			mode: 'dry-run', optionValue: 'other',
			captureFieldKey: AIH_FINISHER_SEGMENT_FIELD,
			captureDateFieldKey: AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
			now: '2026-10-01T00:00:00Z',
		})
		expect(result.status).toBe('dry-run')
	})

	it('keeps finisher field values without a Kit write or even a Kit identity', async () => {
		vi.stubEnv('AIH_KIT_MIRROR_WRITES_ENABLED', 'false')
		const updateSubscriberFields = vi.fn()
		const result = await captureValuePathFinisherFields({
			provider: { updateSubscriberFields },
			mode: 'scoped-live',
			email: 'learner@example.test',
			optionValue: 'other',
			captureFieldKey: AIH_FINISHER_SEGMENT_FIELD,
			captureDateFieldKey: AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
			now: '2026-10-01T00:00:00Z',
		})
		expect(result).toEqual({
			status: 'mirror-disabled',
			fields: {
				aih_finisher_segment: 'other',
				aih_next_course_waitlist_at: '2026-10-01T00:00:00Z',
			},
		})
		expect(updateSubscriberFields).not.toHaveBeenCalled()
	})
})
