export const GITHUB_SOURCE_SYNC_REQUESTED_EVENT =
	'github-source/sync.requested' as const

export type GithubSourceSyncRequested = {
	name: typeof GITHUB_SOURCE_SYNC_REQUESTED_EVENT
	data: {
		changedPaths?: string[]
		repositoryFullName?: string
		ref?: string
		deliveryId?: string
		source: 'github-webhook' | 'manual' | 'cron'
	}
}
