import { z } from 'zod'

export const CreateMultipartUploadSchema = z.object({
	filename: z.string().min(1),
})

export const CompleteMultipartUploadSchema = z.object({
	key: z.string().min(1),
	uploadId: z.string().min(1),
	parts: z.array(
		z.object({
			partNumber: z.number().int().positive(),
			etag: z.string().min(1),
		}),
	),
})
