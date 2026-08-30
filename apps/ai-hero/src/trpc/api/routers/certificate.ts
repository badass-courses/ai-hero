import { courseBuilderAdapter } from '@/db'
import { contentResource } from '@/db/schema'
import {
	isCrashCourseCertificateV1Enabled,
	readCrashCourseCertificateGate,
} from '@/lib/crash-course-certificate-gate'
import { AI_CODING_CRASH_COURSE_FINAL_QUIZ } from '@/lib/crash-course-certificate-eligibility'
import { ensureCrashCourseCertificateShare } from '@/lib/crash-course-certificate-shares'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import { buildCertificateShareUrl } from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from '@/trpc/api/trpc'
import { cloudinary } from '@/utils/cloudinary'
import { z } from 'zod'
import { getCertificatePublicId } from '@coursebuilder/core/lib/certificates'
import { eq, or, sql } from 'drizzle-orm'

const clResourceSchema = z.object({
	secure_url: z.string(),
})

export const certificateRouter = createTRPCRouter({
	crashCourseEligibility: protectedProcedure.query(async ({ ctx }) => {
		const gate = await readCrashCourseCertificateGate({
			userId: ctx.session.user.id,
		})
		if (gate.status === 'unavailable') {
			await log.warn('certificate.crash_course.eligibility_unavailable', {
				userId: ctx.session.user.id,
				reason: gate.reason,
			})
		}
		return gate
	}),
	ensureCrashCourseShare: protectedProcedure.mutation(async ({ ctx }) => {
		const gate = await readCrashCourseCertificateGate({
			userId: ctx.session.user.id,
		})
		if (gate.status !== 'granted') {
			return {
				available: false as const,
				reason:
					gate.status === 'disabled'
						? 'certificate-gate-disabled'
						: gate.reason,
			}
		}

		const user = await courseBuilderAdapter.getUserById(ctx.session.user.id)
		if (!user) {
			return { available: false as const, reason: 'user-not-found' }
		}

		try {
			const result = await ensureCrashCourseCertificateShare({
				eligibility: gate.eligibility,
				learnerName: user.name || user.email,
			})
			if (!result.available) return result
			return {
				...result,
				permalink: buildCertificateShareUrl({
					slug: result.share.slug,
					baseUrl: process.env.NEXT_PUBLIC_URL ?? 'https://www.aihero.dev',
				}),
			}
		} catch (error) {
			await log.error('certificate.crash_course.share_failed', {
				userId: ctx.session.user.id,
				error: error instanceof Error ? error.message : String(error),
			})
			return {
				available: false as const,
				reason: 'share-persistence-failed',
			}
		}
	}),
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
	upload: protectedProcedure
		.input(
			z.object({
				imagePath: z.string(),
				resourceIdOrSlug: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (isCrashCourseCertificateV1Enabled()) {
				const resource = await ctx.db.query.contentResource.findFirst({
					columns: { id: true },
					where: or(
						eq(contentResource.id, input.resourceIdOrSlug),
						eq(
							sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`,
							input.resourceIdOrSlug,
						),
					),
				})
				if (
					resource?.id === AI_CODING_CRASH_COURSE_FINAL_QUIZ.courseResourceId
				) {
					return {
						error: 'Crash Course certificates use the server-owned share path',
					}
				}
			}

			const user = await courseBuilderAdapter.getUserById(ctx.session.user.id)
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
		.query(async ({ input }) => {
			const { session } = await getServerAuthSession()
			const userId = session?.user?.id
			if (!userId) return null
			const user = await courseBuilderAdapter.getUserById(userId)

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
