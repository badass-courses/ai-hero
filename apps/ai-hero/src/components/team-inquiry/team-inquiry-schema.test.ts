import { describe, expect, it } from 'vitest'

import { COUNTRIES } from './countries'
import {
	getTeamInquirySchema,
	teamInquirySchema,
	TRAINING_TOPICS,
} from './team-inquiry-schema'

const values = {
	name: 'Test Person',
	email: 'team@example.test',
	companyName: 'Test Company',
	teamSize: '1-10',
	website: '',
	timestamp: new Date().toISOString(),
}
const live = {
	...values,
	country: 'US',
	trainingType: 'live',
	engineersToTrain: '10-25',
	format: 'Remote',
	topics: [TRAINING_TOPICS[0]],
	timing: 'This month',
}
const schema = getTeamInquirySchema('training-partners')

describe('team inquiry validation', () => {
	it('keeps partner fields optional for existing inquiries', () => {
		expect(teamInquirySchema.safeParse(values).success).toBe(true)
		for (const source of [undefined, 'workshop', 'for-teams-page'])
			expect(getTeamInquirySchema(source).safeParse(values).success).toBe(true)
	})
	it('requires country and training type', () => {
		const result = schema.safeParse(values)
		expect(result.success).toBe(false)
		if (!result.success)
			expect(result.error.issues.map((issue) => issue.path[0])).toEqual([
				'country',
				'trainingType',
			])
	})
	it('accepts a complete live request', () =>
		expect(schema.safeParse(live).success).toBe(true))
	it.each(['engineersToTrain', 'format', 'topics', 'timing'])(
		'requires %s only for live requests',
		(field) => {
			expect(schema.safeParse({ ...live, [field]: undefined }).success).toBe(
				false,
			)
			expect(
				schema.safeParse({
					...values,
					country: 'DE',
					trainingType: 'self-paced',
				}).success,
			).toBe(true)
		},
	)
	it('requires a topic and rejects unknown options', () => {
		for (const topics of [[], ['Unknown']])
			expect(schema.safeParse({ ...live, topics }).success).toBe(false)
		for (const fields of [
			{ engineersToTrain: '1000' },
			{ format: 'Unknown' },
			{ timing: 'Yesterday' },
			{ trainingType: 'other' },
		])
			expect(schema.safeParse({ ...live, ...fields }).success).toBe(false)
	})
	it('requires an ISO country and validates alternate locations', () => {
		for (const country of [
			'',
			'   ',
			'Germany',
			'ZZ',
			'de',
			'Germany<script>unsafe</script>',
		])
			expect(schema.safeParse({ ...live, country }).success).toBe(false)
		expect(
			schema.safeParse({ ...live, trainingLocation: 'elsewhere' }).success,
		).toBe(false)
		expect(
			schema.safeParse({
				...live,
				trainingLocation: 'elsewhere',
				trainingCountry: 'GB',
			}).success,
		).toBe(true)
		expect(
			schema.safeParse({
				...live,
				trainingLocation: 'same',
				trainingCountry: '',
			}).success,
		).toBe(true)
		expect(COUNTRIES).toHaveLength(249)
		expect(new Set(COUNTRIES.map(({ code }) => code)).size).toBe(249)
	})
	it('requires a short partner name only when specific is chosen for live training', () => {
		for (const specificPartner of ['', ' ', 'a'.repeat(121)])
			expect(
				schema.safeParse({
					...live,
					partnerPreference: 'specific',
					specificPartner,
				}).success,
			).toBe(false)
		expect(
			schema.safeParse({
				...live,
				partnerPreference: 'specific',
				specificPartner: 'A partner',
			}).success,
		).toBe(true)
		expect(
			schema.safeParse({
				...live,
				trainingType: 'self-paced',
				partnerPreference: 'specific',
				specificPartner: '',
			}).success,
		).toBe(true)
	})
})
