import { courseBuilderAdapter } from '@/db'
import {
	sortByStartTime,
	validateChapters,
} from '@/components/video-chapters/chapter-utils'
import {
	attachVideoResourceToPost,
	detachVideoResourceFromPost,
	getAllVideoResources,
	getPaginatedVideoResources,
} from '@/lib/video-resource-query'
import { log } from '@/server/logger'
import { createTRPCRouter, protectedProcedure } from '@/trpc/api/trpc'
import { VideoChapterSchema } from '@coursebuilder/core/schemas'
import { TRPCError } from '@trpc/server'
import { revalidateTag } from 'next/cache'
import { z } from 'zod'

export const videoResourceRouter = createTRPCRouter({
	get: protectedProcedure
		.input(
			z.object({
				videoResourceId: z.string().nullable().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const canAccessVideoResources =
				ctx.ability.can('read', 'Content') ||
				ctx.ability.can('create', 'Content')

			if (!canAccessVideoResources) {
				throw new TRPCError({ code: 'UNAUTHORIZED' })
			}

			return courseBuilderAdapter.getVideoResource(input.videoResourceId)
		}),
	getAll: protectedProcedure.query(async ({ ctx }) => {
		const canAccessVideoResources =
			ctx.ability.can('read', 'Content') || ctx.ability.can('create', 'Content')

		if (!canAccessVideoResources) {
			throw new TRPCError({ code: 'UNAUTHORIZED' })
		}

		return await getAllVideoResources()
	}),
	getPaginated: protectedProcedure
		.input(
			z
				.object({
					limit: z.number().min(1).max(100).default(20),
					cursor: z.string().optional(),
				})
				.optional()
				.default({}),
		)
		.query(async ({ ctx, input }) => {
			const canAccessVideoResources =
				ctx.ability.can('read', 'Content') ||
				ctx.ability.can('create', 'Content')

			if (!canAccessVideoResources) {
				throw new TRPCError({ code: 'UNAUTHORIZED' })
			}

			return await getPaginatedVideoResources(input.limit, input.cursor)
		}),
	attachToPost: protectedProcedure
		.input(
			z.object({
				postId: z.string(),
				videoResourceId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			return attachVideoResourceToPost(input.postId, input.videoResourceId)
		}),
	detachFromPost: protectedProcedure
		.input(
			z.object({
				postId: z.string(),
				videoResourceId: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			return detachVideoResourceFromPost(input.postId, input.videoResourceId)
		}),
	updateChapters: protectedProcedure
		.input(
			z.object({
				videoResourceId: z.string(),
				chapters: z.array(VideoChapterSchema),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.ability.can('update', 'Content')) {
				await log.warn('videoResource.chapters.update.forbidden', {
					videoResourceId: input.videoResourceId,
					userId: ctx.session?.user?.id,
				})
				throw new TRPCError({ code: 'FORBIDDEN' })
			}

			const videoResource = await courseBuilderAdapter.getVideoResource(
				input.videoResourceId,
			)

			if (!videoResource) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: 'Video resource not found',
				})
			}

			const validationError = validateChapters(
				input.chapters,
				videoResource.duration,
			)
			if (validationError) {
				await log.warn('videoResource.chapters.update.invalid', {
					videoResourceId: input.videoResourceId,
					reason: validationError.kind,
					detail: validationError,
					userId: ctx.session?.user?.id,
				})
				const message =
					validationError.kind === 'duplicate-startTime'
						? 'Duplicate startTime values are not allowed'
						: validationError.kind === 'startTime-exceeds-duration'
							? `Chapter startTime ${validationError.startTime} exceeds video duration ${validationError.duration}`
							: 'Chapter title cannot be empty'
				throw new TRPCError({ code: 'BAD_REQUEST', message })
			}

			const sorted = sortByStartTime(input.chapters)

			const updated = await courseBuilderAdapter.updateContentResourceFields({
				id: input.videoResourceId,
				fields: { chapters: sorted },
			})

			revalidateTag(`video-resource:${input.videoResourceId}`, 'max')

			await log.info('videoResource.chapters.updated', {
				videoResourceId: input.videoResourceId,
				chapterCount: sorted.length,
				userId: ctx.session?.user?.id,
			})

			return updated
		}),
})
