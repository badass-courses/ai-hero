export const TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT =
	'typesense/popularity-sync.requested' as const

export type TypesensePopularitySyncRequested = {
	name: typeof TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT
	data: {
		source: 'cron' | 'manual'
		requestedBy?: string
	}
}
