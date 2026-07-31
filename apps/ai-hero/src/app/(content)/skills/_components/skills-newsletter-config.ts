import {
	SKILLS_COURSE_FIELDS,
	SKILLS_COURSE_FORM_ID,
} from '@/lib/cta/conversion-intent'

export const SKILLS_FORM_ID = SKILLS_COURSE_FORM_ID
export const SKILLS_HOSTED_RESUBSCRIBE_URL =
	'https://total-typescript.kit.com/8af91e5d6d'
export const SKILLS_INTEREST_FIELDS = {
	...SKILLS_COURSE_FIELDS,
	source: 'aihero_skills_page',
} as const
