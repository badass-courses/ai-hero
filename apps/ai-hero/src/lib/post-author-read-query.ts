import 'server-only'

import { redirect } from 'next/navigation'
import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	contentResourceTag as contentResourceTagTable,
} from '@/db/schema'
import { PostSchema, type Post } from '@/lib/posts'
import { log } from '@/server/logger'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

export async function getAllPostsForUser(userId?: string): Promise<Post[]> {
	if (!userId) {
		redirect('/')
	}

	const posts = await db.query.contentResource.findMany({
		where: and(
			eq(contentResource.type, 'post'),
			eq(contentResource.createdById, userId),
		),
		with: {
			tags: {
				with: {
					tag: true,
				},
				orderBy: asc(contentResourceTagTable.position),
			},
			resources: {
				with: {
					resource: true,
				},
				orderBy: asc(contentResourceResource.position),
			},
		},
		orderBy: desc(contentResource.createdAt),
	})

	const postsParsed = z.array(PostSchema).safeParse(posts)
	if (!postsParsed.success) {
		void log.error('post.parse.error', {
			scope: 'all-for-user',
			userId,
			error: postsParsed.error.message,
		})
		return []
	}

	return postsParsed.data
}
