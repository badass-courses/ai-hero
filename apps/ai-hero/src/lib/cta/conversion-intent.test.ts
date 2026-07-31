import {
	conversionIntentContract,
	hasCompletedConversionIntent,
	planConversionIntent,
	withConfirmedConversionFields,
} from './conversion-intent'

describe('conversionIntentContract', () => {
	it('owns the skills-course form, fields, and per-surface attribution', () => {
		expect(
			conversionIntentContract({
				intent: { kind: 'skills-course' },
				surface: 'skills-hero',
				now: new Date('2026-07-31T12:00:00Z'),
			}),
		).toEqual({
			key: 'course:skills',
			formId: 9376133,
			fields: {
				interest: 'skills',
				source: 'aihero_skills_hero',
			},
			tagName: null,
		})

		expect(
			conversionIntentContract({
				intent: { kind: 'skills-course' },
				surface: 'homepage-course',
				now: new Date('2026-07-31T12:00:00Z'),
			}).fields.source,
		).toBe('aihero_homepage')

		expect(
			conversionIntentContract({
				intent: { kind: 'skills-course' },
				surface: 'skills-campaign',
			}).fields.source,
		).toBe('aihero_campaign_ai_skills')
	})

	it('keeps a cohort waitlist field and tag in lockstep', () => {
		expect(
			conversionIntentContract({
				intent: {
					kind: 'cohort-waitlist',
					productName: 'AI Coding for Real Engineers Cohort 4',
				},
				surface: 'homepage-cohort',
				now: new Date('2026-07-31T12:00:00Z'),
			}),
		).toEqual({
			key: 'waitlist:cohort:ai_coding_for_real_engineers_cohort_4',
			formId: undefined,
			fields: {
				waitlist_ai_coding_for_real_engineers_cohort_4: '2026-07-31',
				source: 'aihero_homepage_cohort',
			},
			tagName: 'waitlist_ai_coding_for_real_engineers_cohort_4',
		})
	})

	it('keeps a workshop interest field and tag in lockstep', () => {
		expect(
			conversionIntentContract({
				intent: {
					kind: 'workshop-interest',
					workshopSlug: 'ai-coding-crash-course',
				},
				surface: 'workshop-page',
				now: new Date('2026-07-31T12:00:00Z'),
			}),
		).toEqual({
			key: 'interest:workshop:ai_coding_crash_course',
			formId: undefined,
			fields: {
				interest_ai_coding_crash_course: '2026-07-31',
				source: 'aihero_workshop',
			},
			tagName: 'interest_ai_coding_crash_course',
		})
	})
})

describe('withConfirmedConversionFields', () => {
	it('commits accepted fields when Kit returns a stale subscriber snapshot', () => {
		expect(
			withConfirmedConversionFields(
				{
					id: 42,
					fields: { existing: 'kept', source: 'old-source' },
				},
				{ interest: 'skills', source: 'skill-post' },
			),
		).toEqual({
			id: 42,
			fields: {
				existing: 'kept',
				interest: 'skills',
				source: 'skill-post',
			},
		})
	})
})

describe('planConversionIntent', () => {
	const course = { kind: 'skills-course' } as const

	it('asks an anonymous reader for identity', () => {
		expect(
			planConversionIntent({
				intent: course,
				knownIdentity: false,
				subscriber: null,
			}),
		).toEqual({ mode: 'form' })
	})

	it('offers one click to a signed-in reader absent from Kit', () => {
		expect(
			planConversionIntent({
				intent: course,
				knownIdentity: true,
				subscriber: null,
			}),
		).toEqual({ mode: 'one-click' })
	})

	it('hides an intent only after an active subscriber completed it', () => {
		const completed = {
			state: 'active',
			fields: { aih_course_started_at: '2026-07-31' },
		}
		expect(hasCompletedConversionIntent(course, completed)).toBe(true)
		expect(
			planConversionIntent({
				intent: course,
				knownIdentity: true,
				subscriber: completed,
			}),
		).toEqual({ mode: 'hidden', reason: 'completed' })

		expect(
			hasCompletedConversionIntent(course, {
				state: 'inactive',
				fields: { aih_course_started_at: '2026-07-31' },
			}),
		).toBe(false)
	})

	it('does not promote a legacy Skills newsletter subscriber into the course', () => {
		expect(
			hasCompletedConversionIntent(course, {
				state: 'active',
				fields: { interest: 'skills' },
			}),
		).toBe(false)
	})
})
