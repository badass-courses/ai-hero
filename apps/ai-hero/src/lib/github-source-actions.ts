'use server'

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

	return syncPostFromGithubSource({
		id: resource.id,
		fields: (resource.fields as Record<string, unknown> | null) ?? null,
	})
}
