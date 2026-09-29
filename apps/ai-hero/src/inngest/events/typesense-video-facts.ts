export const TYPESENSE_VIDEO_FACTS_RECONCILE_REQUESTED_EVENT =
	'typesense/video-facts-reconcile.requested' as const

export type TypesenseVideoFactsReconcileRequested = {
	name: typeof TYPESENSE_VIDEO_FACTS_RECONCILE_REQUESTED_EVENT
	data: {
		source: 'cron' | 'manual'
		requestedBy?: string
	}
}
