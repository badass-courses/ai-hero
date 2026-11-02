import { z } from 'zod'

export const teamInquirySchema = z.object({
	name: z.string().min(1, 'Name is required'),
	email: z.string().email('Invalid email address'),
	companyName: z.string().min(1, 'Company name is required'),
	teamSize: z.enum(['1-10', '11-50', '51-200', '201+']),
	message: z.string().optional(),
	country: z.string().optional(),
	trainingType: z.enum(['live', 'self-paced']).optional(),
	// Honeypot field - should always be empty
	website: z.string().max(0, 'Invalid submission'),
	// Timestamp validation
	timestamp: z.string(),
})

export const getTeamInquirySchema = (source?: string) =>
	teamInquirySchema.superRefine((values, ctx) => {
		if (source !== 'training-partners') return
		if (!values.country?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['country'],
				message: 'Country is required',
			})
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
