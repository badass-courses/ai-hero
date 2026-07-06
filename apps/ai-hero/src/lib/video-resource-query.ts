'use server'

import { courseBuilderAdapter, db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	VIDEO_ATTACHED_EVENT,
	VIDEO_DETACHED_EVENT,
} from '@/inngest/events/video-attachment'
import { inngest } from '@/inngest/inngest.server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { and, desc, eq, lt, notExists, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

export async function getVideoResource(id: string | null | undefined) {
	return courseBuilderAdapter.getVideoResource(id)
}

export type PaginatedVideoResourcesResponse = {
	items: z.infer<typeof ContentResourceSchema>[]
	hasNextPage: boolean
	nextCursor: string | null
	error?: string
}

/**
 * Get paginated video resources with cursor-based pagination
 * @param limit - Number of items to return (default: 20)
 * @param cursor - Cursor for pagination (ISO date string)
 * @returns Object with video resources, hasNextPage, and nextCursor
 */
export async function getPaginatedVideoResources(
	limit: number = 20,
	cursor?: string,
): Promise<PaginatedVideoResourcesResponse> {
	try {
		// Validate limit parameter
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			await log.warn('video-resources.paginated.invalid-limit', {
				providedLimit: limit,
				defaultingTo: 20,
			})
			limit = 20 // Default to safe value
		}

		// Validate cursor parameter if provided
		let cursorDate: Date | null = null
		if (cursor) {
			if (typeof cursor !== 'string' || cursor.trim() === '') {
				throw new Error(
					`Invalid cursor format: cursor must be a non-empty string`,
				)
			}

			// Validate ISO date string format and create Date object
			cursorDate = new Date(cursor)
			if (isNaN(cursorDate.getTime())) {
				throw new Error(
					`Invalid cursor date: "${cursor}" is not a valid ISO date string`,
				)
			}

			// Additional validation: ensure date is not in the future (with some tolerance)
			const now = new Date()
			const maxFutureDate = new Date(now.getTime() + 1000 * 60 * 60) // 1 hour tolerance
			if (cursorDate > maxFutureDate) {
				throw new Error(
					`Invalid cursor date: "${cursor}" is too far in the future`,
				)
			}
		}

		const conditions = [eq(contentResource.type, 'videoResource')]

		if (cursorDate) {
			conditions.push(lt(contentResource.createdAt, cursorDate))
		}

		const videoResources = await db.query.contentResource.findMany({
			where: and(...conditions),
			with: {
				resources: {
					with: {
						resource: true,
					},
				},
			},
			orderBy: [desc(contentResource.createdAt)],
			limit: limit + 1, // Fetch one extra to check if there's a next page
		})

		const hasNextPage = videoResources.length > limit
		const items = hasNextPage ? videoResources.slice(0, limit) : videoResources
		const lastItem = items[items.length - 1]
		const nextCursor =
			hasNextPage && items.length > 0 && lastItem?.createdAt
				? lastItem.createdAt.toISOString()
				: null

		await log.info('video-resources.paginated.fetch.success', {
			count: items.length,
			hasNextPage,
			cursor,
			validatedLimit: limit,
		})

		const validatedResults = z.array(ContentResourceSchema).safeParse(items)

		if (!validatedResults.success) {
			await log.error('video-resources.paginated.validation.failed', {
				error: validatedResults.error.format(),
			})
			return {
				items: [],
				hasNextPage: false,
				nextCursor: null,
			}
		}

		return {
			items: validatedResults.data,
			hasNextPage,
			nextCursor,
		}
	} catch (error) {
		await log.error('video-resources.paginated.fetch.failed', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			providedCursor: cursor,
			providedLimit: limit,
		})

		// Return empty result with descriptive error for client
		return {
			items: [],
			hasNextPage: false,
			nextCursor: null,
			error: error instanceof Error ? error.message : 'Unknown error occurred',
		}
	}
}

export async function getAllVideoResources() {
	const ALLOWED_ASSOCIATED_TYPES = ['raw-transcript']

	try {
		const videoResources = await db.query.contentResource.findMany({
			where: and(eq(contentResource.type, 'videoResource')),
			with: {
				resources: {
					with: {
						resource: true,
					},
				},
			},
			orderBy: [desc(contentResource.createdAt)],
		})

		await log.info('video-resources.fetch.success', {
			count: videoResources.length,
		})

		const validatedResults = z
			.array(ContentResourceSchema)
			.safeParse(videoResources)

		if (!validatedResults.success) {
			await log.error('video-resources.validation.failed', {
				error: validatedResults.error.format(),
			})
			return []
		}

		return validatedResults.data
	} catch (error) {
		await log.error('video-resources.fetch.failed', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
		return []
	}
}

/**
 * Attaches a video resource to an owning resource, replacing any existing
 * videoResource child — the safe-swap behind "Use as primary video" and the
 * Media tab's "Set as primary". Generic over the owner despite the legacy
 * `postId` name: the join write (`resourceOfId`) and the Inngest
 * attach/detach events (PartyKit room = the owner's id) work identically for
 * posts, lessons, solutions, and skill changelogs.
 *
 * Ability-gated (`update Content`) because the cms Video tab calls it
 * directly as a server action.
 *
 * @param postId - The ID of the owning resource (post/lesson/solution/…)
 * @param videoResourceId - The ID of the video resource to attach
 * @returns True if successful, false otherwise
 */
export async function attachVideoResourceToPost(
	postId: string,
	videoResourceId: string,
) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	try {
		// First, check if the post already has a video resource attached
		const existingVideoResources =
			await db.query.contentResourceResource.findMany({
				where: and(
					eq(contentResourceResource.resourceOfId, postId),
					eq(
						sql`(SELECT type FROM ${contentResource} WHERE id = ${contentResourceResource.resourceId})`,
						'videoResource',
					),
				),
				with: {
					resource: true,
				},
			})

		// If there are existing video resources, detach them
		if (existingVideoResources.length > 0) {
			for (const existingResource of existingVideoResources) {
				await db
					.delete(contentResourceResource)
					.where(
						and(
							eq(contentResourceResource.resourceOfId, postId),
							eq(
								contentResourceResource.resourceId,
								existingResource.resourceId,
							),
						),
					)

				await log.info('post.video.detached', {
					postId,
					videoResourceId: existingResource.resourceId,
				})

				// Send Inngest event for video detachment
				try {
					await inngest.send({
						name: VIDEO_DETACHED_EVENT,
						data: {
							postId,
							videoResourceId: existingResource.resourceId,
						},
					})
				} catch (error) {
					await log.error('post.video.detach.inngest.failed', {
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						postId,
						videoResourceId: existingResource.resourceId,
					})
				}
			}
		}

		// Now attach the new video resource
		await db
			.insert(contentResourceResource)
			.values({ resourceOfId: postId, resourceId: videoResourceId })

		await log.info('post.video.attached', {
			postId,
			videoResourceId,
		})

		// Send Inngest event for video attachment
		try {
			await inngest.send({
				name: VIDEO_ATTACHED_EVENT,
				data: {
					postId,
					videoResourceId,
				},
			})
		} catch (error) {
			await log.error('post.video.attach.inngest.failed', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				postId,
				videoResourceId,
			})
		}

		return true
	} catch (error) {
		await log.error('post.video.attach.failed', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			postId,
			videoResourceId,
		})
		return false
	}
}

/**
 * Detaches a video resource from an owning resource. Generic over the owner
 * despite the legacy `postId` name (see `attachVideoResourceToPost`).
 * Ability-gated (`update Content`) — called directly from the cms Video tab.
 *
 * @param postId - The ID of the owning resource (post/lesson/solution/…)
 * @param videoResourceId - The ID of the video resource to detach
 * @returns True if successful, false otherwise
 */
export async function detachVideoResourceFromPost(
	postId: string,
	videoResourceId: string,
) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	try {
		await db
			.delete(contentResourceResource)
			.where(
				and(
					eq(contentResourceResource.resourceOfId, postId),
					eq(contentResourceResource.resourceId, videoResourceId),
				),
			)

		await log.info('post.video.detached', {
			postId,
			videoResourceId,
		})

		// Send Inngest event for video detachment
		try {
			await inngest.send({
				name: VIDEO_DETACHED_EVENT,
				data: {
					postId,
					videoResourceId,
				},
			})
		} catch (error) {
			await log.error('post.video.detach.inngest.failed', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				postId,
				videoResourceId,
			})
		}

		return true
	} catch (error) {
		await log.error('post.video.detach.failed', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			postId,
			videoResourceId,
		})
		return false
	}
}

/** JSON_UNQUOTE(JSON_EXTRACT(…)) yields the STRING 'null' for JSON null. */
function jsonString(value: string | null | undefined): string | null {
	return value != null && value !== 'null' && value !== '' ? value : null
}

/**
 * One video's full detail for the cms Media/Video surfaces
 * (`videoLibrary.get` → the kit's `VideoDetail`). Built server-side (rather
 * than in the client binding) because `muxHref` needs server-only env: with
 * BOTH `MUX_ORGANIZATION_ID` and `MUX_ENVIRONMENT_ID` set (and a Mux asset),
 * it becomes the dashboard deep link behind "Open in Mux ↗"; unset env →
 * omitted → the link is hidden.
 *
 * The adapter's `getVideoResource` SELECTs a fixed field list that predates
 * titles/resolution, so those two ride a single-row JSON read (no sort, no
 * Vitess risk).
 */
export async function getVideoResourceMediaDetail(videoResourceId: string) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const video = await courseBuilderAdapter.getVideoResource(videoResourceId)
	if (!video) return null

	const extras = await db
		.select({
			title: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
			resolution: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.max_stored_resolution'))`,
		})
		.from(contentResource)
		.where(eq(contentResource.id, videoResourceId))
		.then((rows) => rows[0])

	const org = env.MUX_ORGANIZATION_ID
	const environment = env.MUX_ENVIRONMENT_ID
	const muxAssetId = video.muxAssetId ?? null

	return {
		id: video.id,
		state: video.state,
		muxPlaybackId: video.muxPlaybackId ?? null,
		title: jsonString(extras?.title) ?? video.title ?? null,
		duration: video.duration ?? null,
		transcript: video.transcript ?? null,
		muxAssetId,
		muxHref:
			muxAssetId && org && environment
				? `https://dashboard.mux.com/organizations/${org}/environments/${environment}/video/assets/${muxAssetId}`
				: null,
		createdAt: video.createdAt ?? null,
		resolution: jsonString(extras?.resolution),
	}
}

/**
 * Rename a videoResource (`videoLibrary.rename` — the preview dialog's
 * inline rename). Persists `fields.title` (already on the core
 * `VideoResourceSchema`); an empty/whitespace title clears it back to null
 * so the id-as-filename fallback returns.
 */
export async function renameVideoResource(
	videoResourceId: string,
	title: string,
) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const trimmed = title.trim()
	await courseBuilderAdapter.updateContentResourceFields({
		id: videoResourceId,
		fields: { title: trimmed.length > 0 ? trimmed : null },
	})

	await log.info('video-resource.renamed', {
		videoResourceId,
		title: trimmed,
	})
}
