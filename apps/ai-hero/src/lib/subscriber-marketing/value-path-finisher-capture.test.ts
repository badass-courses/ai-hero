import { describe, expect, it, vi } from 'vitest'

import {
	AIH_FINISHER_SEGMENT_FIELD,
	AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
	captureValuePathFinisherFields,
} from './value-path-finisher-capture'

const now = '2026-07-18T04:30:00.000Z'

describe('value path finisher capture', () => {
	it('writes the selected segment and waitlist date through one bounded provider call', async () => {
		const updateSubscriberFields = vi.fn().mockResolvedValue({ id: 'kit-1' })
		const result = await captureValuePathFinisherFields({
			provider: { updateSubscriberFields },
			mode: 'scoped-live',
			email: 'learner@example.com',
			kitSubscriberId: 'kit-1',
			optionValue: 'placeholder-option-a',
			captureFieldKey: AIH_FINISHER_SEGMENT_FIELD,
			captureDateFieldKey: AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
			now,
		})
		expect(result).toEqual({
			status: 'written',
			fields: {
				aih_finisher_segment: 'placeholder-option-a',
				aih_next_course_waitlist_at: now,
			},
		})
		expect(updateSubscriberFields).toHaveBeenCalledOnce()
		expect(updateSubscriberFields).toHaveBeenCalledWith({
			subscriberId: 'kit-1',
			subscriberEmail: 'learner@example.com',
			fields: {
				aih_finisher_segment: 'placeholder-option-a',
				aih_next_course_waitlist_at: now,
			},
		})
	})

	it('excludes canary and drill fixtures from Kit field writes', async () => {
		const updateSubscriberFields = vi.fn()
		const result = await captureValuePathFinisherFields({
			provider: { updateSubscriberFields },
			mode: 'scoped-live',
			email: 'joel+aih-synth-canary-learner-v1-generation-1@badass.dev',
			optionValue: 'placeholder-option-a',
			captureFieldKey: AIH_FINISHER_SEGMENT_FIELD,
			captureDateFieldKey: AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
			now,
		})
		expect(result).toMatchObject({
			status: 'excluded',
			reviewReasons: ['learner-flow-fixture-kit-field-write-excluded'],
		})
		expect(updateSubscriberFields).not.toHaveBeenCalled()
	})

	it('refuses arbitrary custom field keys', async () => {
		const result = await captureValuePathFinisherFields({
			mode: 'scoped-live',
			email: 'learner@example.com',
			optionValue: 'placeholder-option-a',
			captureFieldKey: 'arbitrary_field',
			captureDateFieldKey: AIH_NEXT_COURSE_WAITLIST_AT_FIELD,
			now,
		})
		expect(result).toMatchObject({
			status: 'blocked',
			reviewReasons: ['finisher-segment-field-key-invalid'],
		})
	})
})
