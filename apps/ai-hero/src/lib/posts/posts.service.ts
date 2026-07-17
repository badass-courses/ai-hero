import { revalidatePath } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag,
} from '@/db/schema'
import { RESOURCE_CREATED_EVENT } from '@/inngest/events/resource-management'
import { inngest } from '@/inngest/inngest.server'
import {
	NewPostInputSchema,
	PostActionSchema,
	PostSchema,
	PostUpdateSchema,
	type PostAction,
} from '@/lib/posts'
import { getContentReadFilters } from '@/lib/content-read-policy'
import { log } from '@/server/logger'
import { Ability, subject } from '@casl/ability'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'

import {
	deletePostFromDatabase,
	getAllPosts,
	getAllPostsForUser,
	writeNewPostToDatabase,
	writePostUpdateToDatabase,
} from '../posts-query'

export class PostError extends Error {
	constructor(
		message: string,
		public statusCode: number = 400,
		public details?: unknown,
	) {
		super(message)
	}
}

async function getPost(slugOrId: string, ability: Ability) {
	void log.debug('post.query', {
		phase: 'start',
		slugOrId,
	})

	const { states, visibility } = getContentReadFilters(ability)

	const post = await db.query.contentResource.findFirst({
		where: and(
			or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
				eq(contentResource.id, slugOrId),
				eq(contentResource.id, `post_${slugOrId.split('~')[1]}`),
			),
			eq(contentResource.type, 'post'),
			inArray(
				sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`,
				visibility,
			),
			inArray(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, states),
		),
		with: {
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceTag.position),
			},
		},
	})

	if (!post) {
		void log.warn('post.query.not-found', {
			slugOrId,
		})
		return null
	}

	const postParsed = PostSchema.safeParse(post)
	if (!postParsed.success) {
		void log.error('post.query.error', {
			slugOrId,
			postId: post.id,
			error: postParsed.error.message,
		})
		throw new PostError('Invalid post data in database', 500, postParsed.error)
	}

	void log.debug('post.query', {
		phase: 'found',
		slugOrId,
		postId: postParsed.data.id,
	})
	return postParsed.data
}

// New function that doesn't require session
export async function getPostById({
	id,
	ability,
}: {
	id: string
	ability: Ability
}) {
	void log.debug('post.query', {
		phase: 'get-by-id',
		postId: id,
	})
	const post = await getPost(id, ability)

	if (!post) {
		void log.warn('post.query.not-found', {
			postId: id,
		})
		throw new PostError('Post not found', 404)
	}

	if (ability.cannot('read', subject('Content', post))) {
		void log.warn('post.permission-denied', {
			action: 'read',
			postId: id,
		})
		throw new PostError('Unauthorized', 401)
	}

	void log.debug('post.query', {
		phase: 'retrieved',
		postId: post.id,
	})
	return post
}

export async function createPost({
	data,
	userId,
	ability,
}: {
	data: any
	userId: string
	ability: Ability
}) {
	if (ability.cannot('create', 'Content')) {
		throw new PostError('Forbidden', 403)
	}

	const validatedData = NewPostInputSchema.safeParse({
		...data,
		createdById: userId,
	})

	if (!validatedData.success) {
		throw new PostError('Invalid input', 400, validatedData.error)
	}

	try {
		const post = await writeNewPostToDatabase({
			title: validatedData.data.title,
			videoResourceId: validatedData.data.videoResourceId || undefined,
			postType: validatedData.data.postType,
			createdById: userId,
		})

		await inngest.send({
			id: `post-created:${post.id}`,
			name: RESOURCE_CREATED_EVENT,
			data: { id: post.id, type: post.type ?? 'post' },
		})

		return post
	} catch (error) {
		throw new PostError('Failed to create post', 500, error)
	}
}

export async function getPosts({
	userId,
	ability,
	slug,
}: {
	userId?: string
	ability: Ability
	slug?: string | null
}) {
	if (slug) {
		void log.debug('post.query', {
			phase: 'get-by-slug',
			slugOrId: slug,
		})
		const post = await getPost(slug, ability)

		if (!post) {
			void log.warn('post.query.not-found', {
				slugOrId: slug,
			})
			throw new PostError('Post not found', 404)
		}

		if (ability.cannot('read', subject('Content', post))) {
			void log.warn('post.permission-denied', {
				action: 'read',
				postId: post.id,
				slugOrId: slug,
			})
			throw new PostError('Unauthorized', 401)
		}

		void log.debug('post.query', {
			phase: 'retrieved',
			postId: post.id,
			slugOrId: slug,
		})
		return post
	}

	if (ability.cannot('read', 'Content')) {
		throw new PostError('Unauthorized', 401)
	}

	return ability.can('read_privileged', 'Content')
		? getAllPosts()
		: getAllPostsForUser(userId)
}

export async function updatePost({
	id,
	data,
	action,
	userId,
	ability,
}: {
	id: string
	data: unknown
	action: unknown
	userId: string
	ability: Ability
}) {
	void log.info('post.update.start', {
		postId: id,
		requestedAction: typeof action === 'string' ? action : undefined,
		userId,
		dataKeys: data ? Object.keys(data as object) : [],
	})

	const actionResult = PostActionSchema.safeParse(action || 'save')
	if (!actionResult.success) {
		void log.error('post.update.invalid-action', {
			postId: id,
			requestedAction: typeof action === 'string' ? action : undefined,
			userId,
			error: actionResult.error.message,
		})
		throw new PostError('Invalid action', 400, actionResult.error)
	}

	void log.debug('post.update.fetch', {
		postId: id,
		action: actionResult.data,
		userId,
	})
	const originalPost = await getPost(id, ability)
	if (!originalPost) {
		void log.warn('post.update.not-found', {
			postId: id,
			action: actionResult.data,
			userId,
		})
		throw new PostError('Post not found', 404)
	}

	void log.debug('post.update.permission-check', {
		postId: id,
		action: actionResult.data,
		userId,
	})
	if (ability.cannot('manage', subject('Content', originalPost))) {
		void log.warn('post.permission-denied', {
			userId,
			postId: id,
			action: actionResult.data,
		})
		throw new PostError('Forbidden', 403)
	}

	// Handle state transitions for all actions
	const getNewState = (
		action: PostAction,
	): 'draft' | 'published' | 'archived' | 'deleted' => {
		switch (action) {
			case 'publish':
				return 'published'
			case 'unpublish':
				return 'draft'
			case 'archive':
				return 'archived'
			default:
				return originalPost.fields.state
		}
	}

	// For state-changing actions, use current post data with updated state
	const isStateChange = ['publish', 'unpublish', 'archive'].includes(
		actionResult.data,
	)
	const updateData = isStateChange
		? {
				id,
				fields: {
					...originalPost.fields,
					state: getNewState(actionResult.data),
				},
			}
		: data

	void log.debug('post.update.validate', {
		postId: id,
		action: actionResult.data,
		isStateChange,
		newState: isStateChange ? getNewState(actionResult.data) : undefined,
	})

	const validatedData = PostUpdateSchema.safeParse(updateData)
	if (!validatedData.success) {
		void log.error('post.update.invalid-data', {
			postId: id,
			action: actionResult.data,
			error: validatedData.error.message,
		})
		throw new PostError('Invalid input', 400, validatedData.error)
	}

	try {
		void log.info('post.update.write', {
			postId: id,
			action: actionResult.data,
			fieldCount: Object.keys(validatedData.data.fields).length,
		})

		const result = await writePostUpdateToDatabase({
			currentPost: originalPost,
			postUpdate: validatedData.data,
			action: actionResult.data,
			updatedById: userId,
		})
		void log.info('post.update.success', {
			postId: result.id,
			action: actionResult.data,
			newState: result.fields.state,
		})
		void log.debug('post.update.revalidate', {
			postId: result.id,
			path: `/${result.fields.slug}`,
		})
		revalidatePath(`/${result.fields.slug}`)

		return result
	} catch (error: any) {
		void log.error('post.update.error', {
			postId: id,
			action: actionResult.data,
			error: error instanceof Error ? error.message : String(error),
		})
		throw new PostError('Failed to update post', 500, error)
	}
}

export async function deletePost({
	id,
	ability,
}: {
	id: string
	ability: Ability
}) {
	if (!id) {
		throw new PostError('Missing post ID', 400)
	}

	const postToDelete = await courseBuilderAdapter.getContentResource(id)
	if (!postToDelete) {
		throw new PostError('Post not found', 404)
	}

	if (ability.cannot('delete', subject('Content', postToDelete))) {
		throw new PostError('Forbidden', 403)
	}

	try {
		await deletePostFromDatabase(id)

		void log.debug('post.delete.revalidate', {
			postId: id,
			path: `/${postToDelete.fields?.slug}`,
		})
		revalidatePath(`/${postToDelete.fields?.slug}`)

		return { message: 'Post deleted successfully' }
	} catch (error) {
		throw new PostError('Failed to delete post', 500, error)
	}
}
