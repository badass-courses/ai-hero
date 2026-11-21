import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { certificateRenderUrl } from '@/lib/certificate-render-url'
import { checkCohortCertificateEligibility } from '@/lib/certificates'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import { readVerifiedLinkSubscriber } from '@/lib/survey-link-identity'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { cloudinary } from '@/utils/cloudinary'
import { z } from 'zod'
import { getCertificatePublicId } from '@coursebuilder/core/certificates'

const clResourceSchema = z.object({
	secure_url: z.string(),
})

export const certificateRouter = createTRPCRouter({
	/** Has the signed-in learner finished every workshop in this cohort? */
	cohortEligibility: publicProcedure
		.input(z.object({ cohortId: z.string() }))
		.query(async ({ input }) => {
			const { session } = await getServerAuthSession()
			if (!session?.user?.id) return { eligible: false }
			const { hasCompletedCohort } = await checkCohortCertificateEligibility(
				input.cohortId,
				session.user.id,
			)
			return { eligible: hasCompletedCohort }
		}),
	valuePathEligibility: publicProcedure
		.input(
			z.object({
				resourceIdOrSlug: z.literal('value-path:ai-hero-skills-workflow'),
				kitSubscriberId: z.union([z.string(), z.number()]).optional(),
				email: z.string().email().optional(),
				shKit: z.string().max(128).optional(),
			}),
		)
		.query(async ({ input }) => {
			// Answers for the signed-in learner, or for the reader of a hash-verified
			// email link (kitSubscriberId plus sh_kit). This is a publicProcedure,
			// and it used to resolve a caller-chosen kitSubscriberId or email and
			// return that contact's name and email, so anyone could walk subscriber
			// ids and read back the list (security desk, 2026-11-20). The `email`
			// input is still accepted so old clients don't fail validation, but it
			// is never used, and no name or address is returned.
			const { session } = await getServerAuthSession()
			const email =
				session?.user?.email ||
				(
					await readVerifiedLinkSubscriber({
						subscriberId: input.kitSubscriberId,
						shKit: input.shKit,
						route: '/survey',
					})
				)?.email_address
			if (!email) {
				return {
					eligible: false as const,
					resourceIdOrSlug: input.resourceIdOrSlug,
					reason: 'sign-in-required' as const,
				}
			}
			const result = await checkSkillsWorkflowValuePathCertificateEligibility({
				email,
			})
			return {
				eligible: result.eligible,
				resourceIdOrSlug: result.resourceIdOrSlug,
				contactId: 'contactId' in result ? result.contactId : undefined,
				completedAt: 'completedAt' in result ? result.completedAt : undefined,
				reason: 'reason' in result ? result.reason : undefined,
			}
		}),
	upload: publicProcedure
		.input(
			z.object({
				// Still accepted so older clients validate; never fetched (sec-043).
				imagePath: z.string().optional(),
				resourceIdOrSlug: z.string().min(1).max(200),
			}),
		)
		.mutation(async ({ input }) => {
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
			const imagePath = certificateRenderUrl(
				env.NEXT_PUBLIC_URL,
				input.resourceIdOrSlug,
				user.id,
			)
			try {
				// Our own route: ineligible learners get a non-OK answer, and its
				// body is never passed back to the caller.
				const res = await fetch(imagePath, { redirect: 'error' })
				if (!res.ok) return { error: 'Failed to download certificate' }
				return await uploadImage(imagePath, user.id, input.resourceIdOrSlug)
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
