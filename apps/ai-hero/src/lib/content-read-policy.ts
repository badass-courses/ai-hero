import type { Ability } from '@casl/ability'

export function getContentReadFilters(ability: Pick<Ability, 'can'>) {
	const privileged =
		ability.can('update', 'Content') ||
		ability.can('read_privileged', 'Content')
	const states: ('draft' | 'published')[] = privileged
		? ['draft', 'published']
		: ['published']
	const visibility: ('public' | 'private' | 'unlisted')[] = privileged
		? ['public', 'private', 'unlisted']
		: ['public', 'unlisted']

	return { states, visibility }
}
