'use server'

import { db } from '@/db'
import { resourceProgress } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import Typesense from 'typesense'
import type { MultiSearchRequestSchema } from 'typesense/lib/Typesense/MultiSearch'
import { z } from 'zod'

import type { ContentResource } from '@coursebuilder/core/schemas'
import { getTypesenseCollectionName } from '@coursebuilder/utils/typesense-adapter'

const TYPESENSE_COLLECTION_NAME = getTypesenseCollectionName({
	envVar: 'NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME',
	defaultValue: 'content_production',
})

import type { Post, PostAction } from './posts'
import { getPostTags } from './posts-query'
import { getLessonForSolution } from './solutions-query'
import { TypesenseResourceSchema } from './typesense'
import { selectTypesenseRecommendation } from './typesense-recommendations'
import { getVideoResource } from './video-resource-query'
import { getWorkshopsForLesson } from './workshops-query'

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Invalidates the semantic graph caches (global + per-post local) after a
 * Typesense write. Safe to call from background jobs: revalidateTag throws
 * outside a request/render context, so we swallow that.
 */
function revalidatePostsGraph(postId?: string) {
	try {
		revalidateTag('posts-graph', 'max')
		if (postId) revalidateTag(`posts-graph-local-${postId}`, 'max')
	} catch (err) {
		void log.debug('typesense.posts-graph.revalidate-skipped', {
			postId,
			error: getErrorMessage(err),
		})
	}
}

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

function readImageUrl(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	if (typeof v === 'string' && v.length > 0) return v
	if (v && typeof v === 'object' && 'url' in v) {
		const url = (v as Record<string, unknown>).url
		if (typeof url === 'string' && url.length > 0) return url
	}
	return undefined
}

async function deriveResourceImage(
	post: ContentResource,
): Promise<string | undefined> {
	const fromFields =
		readImageUrl(post.fields, 'coverImage') ||
		readImageUrl(post.fields, 'image')
	if (fromFields) return fromFields

	const videoResourceId =
		readString(post.fields, 'videoResourceId') ||
		(post as any)?.resources?.find(
			(r: any) => r?.resource?.type === 'videoResource',
		)?.resourceId
	if (!videoResourceId) return undefined

	try {
		const videoResource = await getVideoResource(videoResourceId)
		const playbackId =
			readString(videoResource as any, 'muxPlaybackId') ||
			readString((videoResource as any)?.fields, 'muxPlaybackId')
		if (!playbackId) return undefined
		const thumbnailTime =
			(post.fields as any)?.thumbnailTime ??
			(videoResource as any)?.fields?.thumbnailTime ??
			0
		return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=720&height=405&fit_mode=smartcrop&time=${thumbnailTime}`
	} catch (err) {
		void log.warn('typesense.image.video.failed', {
			postId: post.id,
			error: getErrorMessage(err),
		})
		return undefined
	}
}

export async function upsertPostToTypeSense(
	post: ContentResource,
	action: PostAction,
) {
	try {
		void log.debug('typesense.upsert.init', {
			host: process.env.NEXT_PUBLIC_TYPESENSE_HOST,
			hasWriteKey: !!process.env.TYPESENSE_WRITE_API_KEY,
			collection: TYPESENSE_COLLECTION_NAME,
		})

		if (
			!process.env.TYPESENSE_WRITE_API_KEY ||
			!process.env.NEXT_PUBLIC_TYPESENSE_HOST
		) {
			void log.warn('typesense.upsert.config-missing', {
				postId: post.id,
				resourceType: post.type,
			})
			return
		}
		const typesenseWriteClient = new Typesense.Client({
			nodes: [
				{
					host: process.env.NEXT_PUBLIC_TYPESENSE_HOST!,
					port: 443,
					protocol: 'https',
				},
			],
			apiKey: process.env.TYPESENSE_WRITE_API_KEY!,
			connectionTimeoutSeconds: 2,
		})

		const shouldIndex = true

		if (!shouldIndex) {
			void log.debug('typesense.upsert.skip-delete', {
				postId: post.id,
				resourceType: post.type,
			})
			try {
				await typesenseWriteClient
					.collections(TYPESENSE_COLLECTION_NAME)
					.documents(String(post.id))
					.delete()
				void log.info('typesense.upsert.skip-delete.success', {
					postId: post.id,
				})
			} catch (err: any) {
				void log.warn('typesense.upsert.skip-delete.failed', {
					postId: post.id,
					error: getErrorMessage(err),
				})
			}
			return
		}

		void log.debug('typesense.tags.fetch', {
			postId: post.id,
			resourceType: post.type,
		})
		const tags = await getPostTags(post.id).catch((err) => {
			void log.warn('typesense.tags.fetch.failed', {
				postId: post.id,
				error: getErrorMessage(err),
			})
			return []
		})

		let parentResources = null
		if (post.type === 'lesson') {
			void log.debug('typesense.parent-resources.fetch', {
				postId: post.id,
				resourceType: post.type,
				parentType: 'workshop',
			})
			parentResources = await getWorkshopsForLesson(post.id)
			void log.debug('typesense.parent-resources.found', {
				postId: post.id,
				resourceType: post.type,
				parentResourceCount: parentResources.length,
			})
		}
		if (post.type === 'solution') {
			void log.debug('typesense.parent-resources.fetch', {
				postId: post.id,
				resourceType: post.type,
				parentType: 'lesson',
			})
			const lesson = await getLessonForSolution(post.id)
			if (lesson) {
				const workshops = await getWorkshopsForLesson(lesson.id)
				parentResources = [lesson, ...workshops]
				void log.debug('typesense.parent-resources.found', {
					postId: post.id,
					resourceType: post.type,
					parentResourceCount: parentResources.length,
				})
			}
		}
		void log.debug('typesense.tags.found', {
			postId: post.id,
			tagCount: tags.length,
		})

		const image = await deriveResourceImage(post)

		void log.debug('typesense.resource.validate', {
			postId: post.id,
			resourceType: post.type,
			action,
		})
		const resource = TypesenseResourceSchema.safeParse({
			id: post.id,
			title: post.fields?.title,
			slug: post.fields?.slug,
			description: post.fields?.body || '',
			summary: post.fields?.description || '',
			image,
			type:
				post?.fields && 'postType' in post.fields
					? post.fields.postType
					: post?.fields && 'type' in post.fields
						? post.fields.type
						: post.type,
			visibility: post.fields?.visibility,
			state: post.fields?.state,
			created_at_timestamp: post.createdAt?.getTime() ?? Date.now(),
			updated_at_timestamp: post.updatedAt?.getTime() ?? Date.now(),
			...(tags.length > 0 && { tags: tags.map((tag) => tag) }),
			...(parentResources && {
				parentResources: parentResources.map((resource) => {
					return {
						id: resource.id,
						title: resource.fields?.title,
						slug: resource.fields?.slug,
						type: resource.type,
						visibility: resource.fields?.visibility,
						state: resource.fields?.state,
					}
				}),
			}),
		})

		if (!resource.success) {
			void log.error('typesense.resource.validate.error', {
				postId: post.id,
				resourceType: post.type,
				action,
				error: resource.error.message,
			})
			return
		}

		void log.debug('typesense.upsert.prepare', {
			postId: resource.data.id,
			resourceType: resource.data.type,
			action,
		})

		try {
			await typesenseWriteClient
				.collections(TYPESENSE_COLLECTION_NAME)
				.documents()
				.create(
					{
						...resource.data,
						...(action === 'publish' && {
							published_at_timestamp: post.updatedAt?.getTime() ?? Date.now(),
						}),
						updated_at_timestamp: post.updatedAt?.getTime() ?? Date.now(),
					},
					{ action: 'emplace' },
				)
			void log.info('typesense.upsert.success', {
				postId: post.id,
				resourceType: post.type,
				action,
			})
			revalidatePostsGraph(post.id)
		} catch (err: any) {
			void log.warn('typesense.upsert.failed', {
				postId: post.id,
				resourceType: post.type,
				error: getErrorMessage(err),
				action,
			})
		}
	} catch (error: any) {
		// Catch any unexpected errors but don't throw
		void log.error('typesense.upsert.unexpected', {
			error: getErrorMessage(error),
			postId: post.id,
			resourceType: post.type,
			action,
		})
	}
}

export async function deletePostInTypeSense(postId: string) {
	try {
		void log.debug('typesense.delete.init', {
			host: process.env.NEXT_PUBLIC_TYPESENSE_HOST,
			hasWriteKey: !!process.env.TYPESENSE_WRITE_API_KEY,
			collection: TYPESENSE_COLLECTION_NAME,
		})

		if (
			!process.env.TYPESENSE_WRITE_API_KEY ||
			!process.env.NEXT_PUBLIC_TYPESENSE_HOST
		) {
			void log.warn('typesense.delete.config-missing', {
				postId,
			})
			return
		}

		let typesenseWriteClient = new Typesense.Client({
			nodes: [
				{
					host: process.env.NEXT_PUBLIC_TYPESENSE_HOST,
					port: 443,
					protocol: 'https',
				},
			],
			apiKey: process.env.TYPESENSE_WRITE_API_KEY,
			connectionTimeoutSeconds: 2,
		})

		try {
			await typesenseWriteClient
				.collections(TYPESENSE_COLLECTION_NAME)
				.documents(postId)
				.delete()
			void log.info('typesense.delete.success', {
				postId,
			})
			revalidatePostsGraph(postId)
		} catch (err: any) {
			// Check if error is "Document not found" - that's actually fine
			if (err.message?.includes('Not Found') || err.httpStatus === 404) {
				void log.debug('typesense.delete.not-found', {
					postId,
				})
				return
			}
			void log.error('typesense.delete.failed', {
				postId,
				error: getErrorMessage(err),
				httpStatus: err.httpStatus,
			})
			throw err
		}
	} catch (error: any) {
		void log.error('typesense.delete.unexpected', {
			error: getErrorMessage(error),
			postId,
		})
		throw error
	}
}

export async function indexAllContentToTypeSense(
	resources: ContentResource[],
	deleteFirst = false,
) {
	let typesenseWriteClient = new Typesense.Client({
		nodes: [
			{
				host: process.env.NEXT_PUBLIC_TYPESENSE_HOST!,
				port: 443,
				protocol: 'https',
			},
		],
		apiKey: process.env.TYPESENSE_WRITE_API_KEY!,
		connectionTimeoutSeconds: 2,
	})

	const indexableResources = resources.filter(
		(resource) =>
			(resource?.fields?.state === 'published' &&
				resource.fields.visibility === 'public' &&
				(resource.type === 'post' ||
					resource.type === 'tutorial' ||
					resource.type === 'workshop' ||
					resource.type === 'event')) ||
			resource.type === 'list',
	)

	const buildDocument = async (resource: ContentResource) => {
		const image = await deriveResourceImage(resource).catch((err) => {
			void log.warn('typesense.index-all.image.failed', {
				resourceId: resource.id,
				error: getErrorMessage(err),
			})
			return undefined
		})
		const now = Date.now()
		// Intentionally omit published_at_timestamp here. With action: 'emplace',
		// existing docs preserve their original publish timestamp (set by the
		// singular publish path); re-indexing won't drift the sort order.
		const parsedResource = TypesenseResourceSchema.safeParse({
			id: resource.id,
			title: resource?.fields?.title,
			slug: resource?.fields?.slug,
			description: resource?.fields?.body || resource?.fields?.description,
			image,
			type: resource.type,
			visibility: resource?.fields?.visibility,
			state: resource?.fields?.state,
			created_at_timestamp: resource.createdAt?.getTime() ?? now,
			updated_at_timestamp: resource.updatedAt?.getTime() ?? now,
		})

		if (!parsedResource.success) {
			void log.error('typesense.index-all.resource.parse.error', {
				resourceId: resource.id,
				resourceType: resource.type,
				error: parsedResource.error.message,
			})
			return null
		}

		return parsedResource.data
	}

	const CONCURRENCY = 20
	const documents: NonNullable<Awaited<ReturnType<typeof buildDocument>>>[] = []
	for (let i = 0; i < indexableResources.length; i += CONCURRENCY) {
		const batch = indexableResources.slice(i, i + CONCURRENCY)
		const built = await Promise.all(batch.map(buildDocument))
		for (const doc of built) {
			if (doc) documents.push(doc)
		}
	}

	if (documents.length === 0) {
		void log.debug('typesense.index-all.empty', {
			collection: TYPESENSE_COLLECTION_NAME,
		})
		return
	}

	if (deleteFirst) {
		void log.debug('typesense.index-all.delete.start', {
			collection: TYPESENSE_COLLECTION_NAME,
		})
		await typesenseWriteClient
			.collections(TYPESENSE_COLLECTION_NAME)
			.documents()
			.delete({
				filter_by: 'visibility:=public',
			})
			.catch((err: any) => {
				void log.error('typesense.index-all.delete.error', {
					collection: TYPESENSE_COLLECTION_NAME,
					error: getErrorMessage(err),
				})
			})
	}

	try {
		await typesenseWriteClient
			.collections(TYPESENSE_COLLECTION_NAME)
			.documents()
			.import(documents, { action: 'emplace' })

		void log.info('typesense.index-all.success', {
			collection: TYPESENSE_COLLECTION_NAME,
			documentCount: documents.length,
		})
	} catch (error) {
		void log.error('typesense.index-all.error', {
			collection: TYPESENSE_COLLECTION_NAME,
			documentCount: documents.length,
			error: getErrorMessage(error),
		})
	}
}

export async function getNearestNeighbour(
	documentId: string,
	numberOfNearestNeighborsToReturn: number,
	distanceThreshold: number,
	documentIdsToSkip?: string[],
) {
	if (
		!process.env.TYPESENSE_WRITE_API_KEY ||
		!process.env.NEXT_PUBLIC_TYPESENSE_HOST
	) {
		void log.warn('typesense.query.config-missing', {
			documentId,
		})
		return
	}
	const typesenseWriteClient = new Typesense.Client({
		nodes: [
			{
				host: process.env.NEXT_PUBLIC_TYPESENSE_HOST!,
				port: 443,
				protocol: 'https',
			},
		],
		apiKey: process.env.TYPESENSE_WRITE_API_KEY!,
		connectionTimeoutSeconds: 2,
	})
	let completedItemIds: string[] = []
	const { session } = await getServerAuthSession()
	if (session?.user?.id) {
		try {
			const progress = await db.query.resourceProgress.findMany({
				where: and(
					eq(resourceProgress.userId, session.user.id),
					isNotNull(resourceProgress.completedAt),
				),
				orderBy: desc(resourceProgress.completedAt),
				columns: {
					resourceId: true,
				},
			})
			completedItemIds = progress?.map((p: any) => p.resourceId) ?? []
		} catch (error) {
			void log.error('typesense.query.progress.error', {
				documentId,
				userId: session.user.id,
				error: getErrorMessage(error),
			})
		}
	}

	const document: any = await typesenseWriteClient
		.collections(TYPESENSE_COLLECTION_NAME)
		.documents(documentId)
		.retrieve()

	if (!document) {
		void log.debug('typesense.query.not-found', {
			documentId,
		})
		return null
	}

	const excludedItemIds = Array.from(
		new Set([documentId, ...completedItemIds, ...(documentIdsToSkip ?? [])]),
	).filter(Boolean)

	const searchRequests: { searches: MultiSearchRequestSchema[] } = {
		searches: [
			{
				collection: TYPESENSE_COLLECTION_NAME,
				q: '*',
				vector_query: `embedding:([${document.embedding.join(', ')}], k:${numberOfNearestNeighborsToReturn}, distance_threshold: ${distanceThreshold})`,
				exclude_fields: 'embedding',
				filter_by: `id:!=[${excludedItemIds.join(',')}] && state:=published && type:=[post,list,article]`,
			},
		],
	}
	const commonSearchParams: Partial<MultiSearchRequestSchema> = {}

	try {
		const { results } = await typesenseWriteClient.multiSearch.perform(
			searchRequests,
			commonSearchParams,
		)

		const parsedResults = z
			.object({
				hits: z.array(
					z.object({
						document: TypesenseResourceSchema,
						vector_distance: z.number().optional(),
					}),
				),
				facetCounts: z.array(z.number()).optional(),
				found: z.number().optional(),
				outOf: z.number().optional(),
				page: z.number().optional(),
				requestParams: z.any().optional(),
				searchCutoff: z.boolean().optional(),
				searchTimeMs: z.number().optional(),
			})
			.array()
			.parse(results)

		const selectedRecommendation = selectTypesenseRecommendation(
			parsedResults[0]?.hits?.map((hit) => ({
				document: hit.document,
				vectorDistance: hit.vector_distance,
			})) ?? [],
		)

		void log.debug('typesense.query.recommendation.selected', {
			documentId,
			selectedId: selectedRecommendation?.id,
			excludedItemIds,
			candidateIds: parsedResults[0]?.hits?.map((hit) => hit.document.id) ?? [],
			candidatePopularity: parsedResults[0]?.hits?.map(
				(hit) => hit.document.popularity_30d ?? 0,
			),
			candidateVectorDistances: parsedResults[0]?.hits?.map(
				(hit) => hit.vector_distance,
			),
		})

		return selectedRecommendation ?? null
	} catch (e) {
		void log.error('typesense.query.error', {
			documentId,
			error: getErrorMessage(e),
		})
		return null
	}
}
