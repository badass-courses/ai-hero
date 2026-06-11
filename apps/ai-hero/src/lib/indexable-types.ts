export const INDEXABLE_TYPES = [
	'post',
	'tutorial',
	'workshop',
	'list',
	'event',
] as const

export type IndexableType = (typeof INDEXABLE_TYPES)[number]
