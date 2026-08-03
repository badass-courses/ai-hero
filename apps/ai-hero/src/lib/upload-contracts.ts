import { z } from 'zod'

export const UploadBodySchema = z.object({
	file: z.object({
		url: z.string().url(),
		name: z.string().optional(),
	}),
	metadata: z.object({
		parentResourceId: z.string(),
	}),
})
