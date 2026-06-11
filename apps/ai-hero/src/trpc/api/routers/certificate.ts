import { courseBuilderAdapter } from '@/db'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { cloudinary } from '@/utils/cloudinary'
import { z } from 'zod'
import { getCertificatePublicId } from '@coursebuilder/core/lib/certificates'

const clResourceSchema = z.object({
	secure_url: z.string(),
})

export const certificateRouter = createTRPCRouter({
	valuePathEligibility: publicProcedure
		.input(
			z.object({
				resourceIdOrSlug: z.literal('value-path:ai-hero-skills-workflow'),
				kitSubscriberId: z.union([z.string(), z.number()]).optional(),
				email: z.string().email().optional(),
			}),
		)
		.query(async ({ input }) => {
			return checkSkillsWorkflowValuePathCertificateEligibility({
				kitSubscriberId: input.kitSubscriberId,
				email: input.email,
			})
		}),
	upload: publicProcedure
		.input(
			z.object({
				imagePath: z.string(),
				resourceIdOrSlug: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { session } = await getServerAuthSession()
			if (!session)
				return {
					error: 'Not authenticated',
				}

			const user = await courseBuilderAdapter.getUserById(
				session?.user?.id as string,
			)
			if (!user)
				return {
					error: 'User not found',
				}
			try {
				const res = await fetch(input.imagePath)
				if (!res.ok) {
					const errorData = await res.json()
					return {
						error: errorData.error || 'Failed to download certificate',
					}
				}
				return await uploadImage(
					input.imagePath,
					user.id,
					input.resourceIdOrSlug,
				)
			} catch {
				return { error: 'Something went wrong' }
			}
		}),
	get: publicProcedure
		.input(
			z.object({
				resourceIdOrSlug: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { session } = await getServerAuthSession()
			if (!session) return null
			const user = await courseBuilderAdapter.getUserById(
				session?.user?.id as string,
			)

			if (!user) return null

			try {
				const cert = await cloudinary.api.resource(
					getCertificatePublicId({
						userId: user.id,
						resourceIdOrSlug: input.resourceIdOrSlug,
					}),
				)

				if (!cert) return null

				const parsedCert = clResourceSchema.parse(cert)
				return parsedCert
			} catch {
				return null
			}
		}),
})

const uploadImage = async (
	imagePath: string,
	userId: string,
	resourceIdOrSlug: string,
) => {
	const options = {
		public_id: getCertificatePublicId({ userId, resourceIdOrSlug }),
		unique_filename: true,
		use_filename: true,
		overwrite: true,
		filename_override: true,
	}

	try {
		const result = await cloudinary.uploader.upload(imagePath, options)
		await log.info('certificate.generated', {
			userId,
			resourceIdOrSlug,
			publicId: result?.public_id,
		})
		return result
	} catch (error) {
		await log.error('certificate.error', {
			userId,
			resourceIdOrSlug,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
