import { getNearestNeighbour } from '@/lib/typesense-query'
import {
	relatedItemMeta,
	resolveRelatedPostItems,
} from '@/app/(content)/[post]/_components/related-posts'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { z } from 'zod'

export const typesenseRouter = createTRPCRouter({
	getRelatedPostItems: publicProcedure
		.input(
			z.object({
				postId: z.string(),
				variant: z.enum(['section', 'suggested']),
				sectionTitle: z.string().optional(),
				documentIdsToSkip: z.array(z.string()).optional(),
			}),
		)
		.query(async ({ input }) => {
			const result = await resolveRelatedPostItems({
				...input,
				personalized: true,
			})

			return result.items.map((item) => ({
				id: item.id,
				title: item.title,
				slug: item.slug,
				meta: relatedItemMeta(item),
			}))
		}),
	getNearestNeighbor: publicProcedure
		.input(
			z.object({
				documentId: z.string(),
				numberOfNearestNeighborsToReturn: z.number().optional().default(5),
				distanceThreshold: z.number().optional().default(1),
				documentIdsToSkip: z.array(z.string()).optional(),
			}),
		)
		.query(async ({ input }) => {
			return await getNearestNeighbour(
				input.documentId,
				input.numberOfNearestNeighborsToReturn,
				input.distanceThreshold,
				input.documentIdsToSkip,
			)
		}),
})
