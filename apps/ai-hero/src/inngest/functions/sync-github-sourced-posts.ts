import { syncAllGithubSourcedPosts } from '@/lib/github-source-sync'

import { GITHUB_SOURCE_SYNC_REQUESTED_EVENT } from '../events/github-source'
import { inngest } from '../inngest.server'

/**
 * Keeps github-sourced post bodies in sync with their source files. Runs hourly
 * as a backstop and on demand via the github-source webhook (which dispatches
 * the event with the paths that changed in a push).
 */
export const syncGithubSourcedPosts = inngest.createFunction(
	{
		id: 'sync-github-sourced-posts',
		name: 'Sync GitHub-Sourced Posts',
		concurrency: { limit: 1 },
	},
	[
		{ cron: 'TZ=UTC 0 * * * *' },
		{ event: GITHUB_SOURCE_SYNC_REQUESTED_EVENT },
	],
	async ({ event, step }) => {
		const data = event?.data
		const changedPaths =
			data && 'changedPaths' in data ? data.changedPaths : undefined
		const source = data && 'source' in data ? data.source : 'cron'

		const results = await step.run('sync github-sourced posts', async () => {
			return syncAllGithubSourcedPosts({ changedPaths })
		})

		return {
			source,
			total: results.length,
			updated: results.filter((result) => result.status === 'updated').length,
			unchanged: results.filter((result) => result.status === 'unchanged')
				.length,
			skipped: results.filter((result) => result.status === 'skipped').length,
			errors: results.filter((result) => result.status === 'error').length,
		}
	},
)
