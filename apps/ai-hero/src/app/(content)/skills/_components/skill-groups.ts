import type { SkillSetGroup } from './skill-set'

/**
 * The /skills list → catalog groups.
 *
 * Lives beside the component rather than in `page.tsx` because it is the one
 * part of that route with a decision in it — what counts as a skill — and a
 * page file can only export a page.
 */

type ListItem = {
	resource?: {
		id?: string
		type?: string
		fields?: Record<string, unknown> | null
		resources?: ListItem[] | null
	} | null
}

function isPublicPublished(fields?: Record<string, unknown> | null) {
	return fields?.state === 'published' && fields?.visibility === 'public'
}

function stringField(
	fields: Record<string, unknown> | null | undefined,
	key: string,
): string | undefined {
	const value = fields?.[key]
	return typeof value === 'string' && value ? value : undefined
}

/**
 * A list member as a catalog row.
 *
 * `kind` is the whole point: the list is allowed to hold something that is not
 * a skill — a "what these skills are" article filed with the skills it explains
 * — and such a row must not render as a slash command. `postType` is what
 * separates them, the same gate `skills-query.ts` uses for the cycle and the
 * rail, so a non-skill row is consistently not-a-skill across every surface.
 */
function toSkillItem(item: ListItem) {
	const fields = item.resource?.fields
	const slug = stringField(fields, 'slug')
	if (!slug) return null
	return {
		slug,
		title: stringField(fields, 'title') ?? slug,
		description: stringField(fields, 'description'),
		kind:
			stringField(fields, 'postType') === 'skill'
				? ('skill' as const)
				: ('article' as const),
	}
}

/**
 * Walk the /skills list into ordered render groups. A `section` resource
 * becomes a titled group of its published/public children; anything else
 * collapses into an untitled run of loose members. Empty sections are dropped
 * so an unpopulated (or fully-unpublished) section leaves no orphan heading.
 */
export function toSkillGroups(resources?: ListItem[] | null): SkillSetGroup[] {
	const groups: SkillSetGroup[] = []
	let looseRun: SkillSetGroup | null = null

	for (const item of resources ?? []) {
		if (item.resource?.type === 'section') {
			// Sections are purely structural — their own state/visibility is
			// ignored (they're created draft+unlisted with no publish UI). Their
			// published/public children drive whether the section shows at all.
			const items = (item.resource.resources ?? [])
				.filter((child) => isPublicPublished(child.resource?.fields))
				.map(toSkillItem)
				.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
			if (items.length === 0) continue
			looseRun = null
			groups.push({
				id: item.resource.id ?? items[0]!.slug,
				title: stringField(item.resource.fields, 'title') ?? 'Skills',
				description: stringField(item.resource.fields, 'description'),
				items,
			})
			continue
		}
		if (!isPublicPublished(item.resource?.fields)) continue
		const entry = toSkillItem(item)
		if (!entry) continue
		if (!looseRun) {
			looseRun = { id: `loose-${groups.length}`, title: null, items: [] }
			groups.push(looseRun)
		}
		looseRun.items.push(entry)
	}

	return groups
}

/**
 * Skills only. The list also carries the odd non-skill article, and every
 * count on the page ("N skills", "See all N skills") is a claim about how many
 * skills you get for installing the set.
 */
export function countSkills(groups: SkillSetGroup[]): number {
	return groups.reduce(
		(total, group) =>
			total + group.items.filter((item) => item.kind === 'skill').length,
		0,
	)
}
