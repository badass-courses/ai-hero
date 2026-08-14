export const CONTENT_RESOURCE_INDEX_REQUESTED_EVENT =
	'content/resource.index-requested' as const

export type ContentResourceIndexRequested = {
	name: typeof CONTENT_RESOURCE_INDEX_REQUESTED_EVENT
	data: {
		resourceId: string
		committedVersionId: string
	}
}

export function contentResourceIndexEventId(input: {
	resourceId: string
	committedVersionId: string
}) {
	return `content-resource-index:${input.resourceId}:${input.committedVersionId}`
}
