import { getLessonMuxPlaybackId } from '@/lib/lessons-query'
import { createTRPCRouter, protectedProcedure } from '@/trpc/api/trpc'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

export const lessonsRouter = createTRPCRouter({
	getLessonMuxPlaybackId: protectedProcedure
		.input(
			z.object({
				lessonIdOrSlug: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const canAccessLessonPlaybackIds =
				ctx.ability.can('read', 'Content') ||
				ctx.ability.can('create', 'Content')

			if (!canAccessLessonPlaybackIds) {
				throw new TRPCError({ code: 'UNAUTHORIZED' })
			}

			return await getLessonMuxPlaybackId(input.lessonIdOrSlug)
		}),
})
