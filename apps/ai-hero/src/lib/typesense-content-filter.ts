import type { AppAbility } from '@/ability'

export const searchContentTypes = [
	'lesson',
	'workshop',
	'article',
	'cohort',
	'post',
	'tutorial',
	'event',
	'dictionary',
	'dictionary-entry',
] as const

export type SearchContentType = (typeof searchContentTypes)[number]

export function isSearchContentType(value: string): value is SearchContentType {
	return (searchContentTypes as readonly string[]).includes(value)
}

export function buildTypesenseContentFilter({
	ability,
	type,
}: {
	ability: AppAbility
	type?: string | null
}) {
	const filterParts = ability.can('read_privileged', 'Content')
		? []
		: ['state:=published', 'visibility:=public']

	if (type) {
		if (!isSearchContentType(type)) {
			throw new Error('Invalid Typesense content type filter')
		}
		filterParts.push(`type:=${type}`)
	}

	return filterParts.length > 0 ? filterParts.join(' && ') : undefined
}
