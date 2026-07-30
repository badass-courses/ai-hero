import { z } from 'zod'

const UnrecognisedPostCtaFieldSchema = z.object({
	kind: z.literal('unrecognised'),
})

export const PostCtaFieldSchema = z
	.union([
		z.null(),
		z.literal('course'),
		z.literal('none'),
		z.object({
			kind: z.literal('course'),
			headline: z.string().optional(),
			subtitle: z.string().optional(),
		}),
		UnrecognisedPostCtaFieldSchema,
	])
	.catch({ kind: 'unrecognised' })

export type PostCtaField = z.infer<typeof PostCtaFieldSchema>

export type CourseCtaCopy = {
	headline: string
	subtitle: string
}

export type ResolvedPostCta =
	| {
			kind: 'course'
			copy: CourseCtaCopy
			source: 'field' | 'postType'
			warning: { code: 'unrecognised-post-cta' } | null
	  }
	| {
			kind: null
			copy: null
			source: 'field' | 'postType'
			warning: { code: 'unrecognised-post-cta' } | null
	  }

const defaultCourseCopy: CourseCtaCopy = {
	headline: 'You have the skill. Now build the workflow around it.',
	subtitle:
		'One command installs all 22 skills. The free course is the order to use them in: seven lessons, from clarifying the work to reviewing the diff. Go as fast as you want.',
}

/**
 * Resolves the field-first CTA declaration without React, database, or logging
 * dependencies. Callers can report `warning` without duplicating precedence.
 */
export function resolvePostCta({
	postType,
	cta,
}: {
	postType: string | null | undefined
	cta: unknown
}): ResolvedPostCta {
	if (cta === undefined || cta === null) {
		return postType === 'skill'
			? {
					kind: 'course',
					copy: defaultCourseCopy,
					source: 'postType',
					warning: null,
				}
			: {
					kind: null,
					copy: null,
					source: 'postType',
					warning: null,
				}
	}

	const field = PostCtaFieldSchema.parse(cta)

	if (field === null) {
		return resolvePostCta({ postType, cta: undefined })
	}

	if (field === 'none') {
		return {
			kind: null,
			copy: null,
			source: 'field',
			warning: null,
		}
	}

	if (field === 'course') {
		return {
			kind: 'course',
			copy: defaultCourseCopy,
			source: 'field',
			warning: null,
		}
	}

	if (field.kind === 'course') {
		return {
			kind: 'course',
			copy: {
				headline: field.headline?.trim() || defaultCourseCopy.headline,
				subtitle: field.subtitle?.trim() || defaultCourseCopy.subtitle,
			},
			source: 'field',
			warning: null,
		}
	}

	const fallback = resolvePostCta({ postType, cta: undefined })
	return {
		...fallback,
		warning: { code: 'unrecognised-post-cta' },
	}
}
