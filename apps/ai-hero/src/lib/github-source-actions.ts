'use server'

import { revalidateTag } from 'next/cache'
import { courseBuilderAdapter } from '@/db'
import {
	syncPostFromGithubSource,
	type SyncResult,
} from '@/lib/github-source-sync'
import { getServerAuthSession } from '@/server/auth'

/**
 * Force an immediate re-sync of a single github-sourced post's body. Admin/
 * editor gated. Powers the "Sync now" control in the editor.
 */
export async function syncGithubSourceNow(postId: string): Promise<SyncResult> {
	const { ability } = await getServerAuthSession()
	if (!ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const resource = await courseBuilderAdapter.getContentResource(postId)
	if (!resource) {
		throw new Error('Post not found')
	}
	if (resource.type !== 'post') {
		throw new Error('GitHub source sync is only supported for posts')
	}

	const result = await syncPostFromGithubSource({
		id: resource.id,
		fields: (resource.fields as Record<string, unknown> | null) ?? null,
	})

	// Manual sync is the recovery path when a page is stale: always flush the
	// post caches, even on an `unchanged` result (the body may already be
	// correct in the DB while a cached page still serves the old render). The
	// engine only revalidates on a real change, keeping the hourly cron cheap.
	if (result.status !== 'error') {
		revalidateTag('posts', 'max')
	}

	return result
}
