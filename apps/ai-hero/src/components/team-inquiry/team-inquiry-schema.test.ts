import { describe, expect, it } from 'vitest'

import { getTeamInquirySchema, teamInquirySchema } from './team-inquiry-schema'

const values = {
	name: 'Test Person',
	email: 'team@example.test',
	companyName: 'Test Company',
	teamSize: '1-10',
	website: '',
	timestamp: new Date().toISOString(),
}

describe('team inquiry validation', () => {
	it('keeps partner fields optional for existing inquiries', () => {
		expect(teamInquirySchema.safeParse(values).success).toBe(true)
		expect(getTeamInquirySchema().safeParse(values).success).toBe(true)
	})

	it('requires both routing fields for training partners', () => {
		const result = getTeamInquirySchema('training-partners').safeParse(values)
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues.map((issue) => issue.path[0])).toEqual([
				'country',
				'trainingType',
			])
		}
	})

	it.each(['live', 'self-paced'])(
		'accepts %s with a country',
		(trainingType) => {
			expect(
				getTeamInquirySchema('training-partners').safeParse({
					...values,
					country: 'Germany',
					trainingType,
				}).success,
			).toBe(true)
		},
	)

	it('rejects blank countries and unknown training types', () => {
		for (const country of ['', '   ']) {
			expect(
				getTeamInquirySchema('training-partners').safeParse({
					...values,
					country,
					trainingType: 'live',
				}).success,
			).toBe(false)
		}
		expect(
			teamInquirySchema.safeParse({ ...values, trainingType: 'other' }).success,
		).toBe(false)
	})
})
