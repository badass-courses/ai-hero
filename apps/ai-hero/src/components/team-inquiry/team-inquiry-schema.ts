import { z } from 'zod'

import { isCountryCode } from './countries'

export const TRAINING_TOPICS = [
	'AI coding workflow (Claude Code, agents)',
	'Team-wide setup and standards',
	'LLM and AI SDK fundamentals',
	'A talk or community session',
	'Other',
] as const

export const TRAINING_TIMINGS = [
	'This month',
	'In 1 to 3 months',
	'Later',
	'Not sure',
] as const

export const teamInquirySchema = z.object({
	name: z.string().min(1, 'Name is required'),
	email: z.string().email('Invalid email address'),
	companyName: z.string().min(1, 'Company name is required'),
	teamSize: z.enum(['1-10', '11-50', '51-200', '201+']),
	message: z.string().optional(),
	country: z.string().optional(),
	trainingType: z.enum(['live', 'self-paced']).optional(),
	trainingLocation: z.enum(['same', 'elsewhere']).optional(),
	trainingCountry: z.string().optional(),
	engineersToTrain: z.enum(['1-9', '10-25', '26-50', '51+']).optional(),
	format: z.enum(['Onsite', 'Remote', 'Either']).optional(),
	topics: z.array(z.enum(TRAINING_TOPICS)).optional(),
	timing: z.enum(TRAINING_TIMINGS).optional(),
	partnerPreference: z.enum(['none', 'specific']).optional(),
	specificPartner: z.string().optional(),
	// Honeypot field - should always be empty
	website: z.string().max(0, 'Invalid submission'),
	// Timestamp validation
	timestamp: z.string(),
})

export const getTeamInquirySchema = (source?: string) =>
	teamInquirySchema.superRefine((values, ctx) => {
		if (source !== 'training-partners') return
		if (!isCountryCode(values.country)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['country'],
				message: 'Choose a country',
			})
		}
		if (
			values.trainingLocation === 'elsewhere' &&
			!isCountryCode(values.trainingCountry)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['trainingCountry'],
				message: 'Choose a training country',
			})
		}
		if (values.trainingType === 'live') {
			for (const field of ['engineersToTrain', 'format', 'timing'] as const) {
				if (!values[field])
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [field],
						message: 'Choose an option',
					})
			}
			if (!values.topics?.length)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['topics'],
					message: 'Choose at least one topic',
				})
			if (
				values.partnerPreference === 'specific' &&
				(!values.specificPartner?.trim() ||
					values.specificPartner.trim().length > 120)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['specificPartner'],
					message: 'Name a partner (up to 120 characters)',
				})
			}
		}
		if (!values.trainingType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['trainingType'],
				message: 'Choose a training type',
			})
		}
	})

export type TeamInquiryFormValues = z.infer<typeof teamInquirySchema>

export type TeamInquiryContext = {
	url: string
	source?: string
}
