import type { Workshop } from '@/lib/workshops'

import type { ContentResourceResource } from '@coursebuilder/core/schemas'

type AccessEdge<T> = Pick<ContentResourceResource, 'resourceId'> & {
	metadata?: Readonly<Record<string, unknown>> | null
	resource?: T | null
}

type AccessResource = { id: string; type: string }

export type WorkshopAccessBranch = AccessResource & {
	resources: readonly AccessEdge<AccessResource>[]
}

// Only the facts the rules consume. The query still returns full join rows.
export type WorkshopAccessTree = Pick<Workshop, 'id' | 'type'> & {
	fields: Pick<Workshop['fields'], 'startsAt'>
	resources: readonly AccessEdge<WorkshopAccessBranch>[] | null
	resourceProducts?: readonly { productId: string }[] | null
}
