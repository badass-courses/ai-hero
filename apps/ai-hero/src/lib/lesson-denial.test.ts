import { describe, expect, it } from 'vitest'

import {
	LESSON_DENIAL_COPY,
	lessonDenialReason,
	type LessonDenialReason,
} from './lesson-denial'

const legacyCopy = () => 'You need to be a member to access this lesson.'

describe('lessonDenialReason', () => {
	const bools = [false, true]
	for (const signedIn of bools)
		for (const isRegionRestricted of bools)
			for (const isPendingOpenAccess of bools)
				for (const hasTeamPool of bools)
					it(`in=${signedIn} region=${isRegionRestricted} pending=${isPendingOpenAccess} team=${hasTeamPool}`, () => {
						const want: LessonDenialReason = isPendingOpenAccess
							? 'pending-open'
							: !signedIn
								? 'signed-out'
								: isRegionRestricted
									? 'region-restricted'
									: hasTeamPool
										? 'team-seat-unclaimed'
										: 'no-purchase'
						expect(
							lessonDenialReason({
								signedIn,
								isRegionRestricted,
								isPendingOpenAccess,
								hasTeamPool,
							}),
						).toBe(want)
					})

	it('every reason has distinct copy; legacy used one line for all', () => {
		const copies = Object.values(LESSON_DENIAL_COPY)
		expect(new Set(copies).size).toBe(copies.length)
		expect(
			Object.entries(LESSON_DENIAL_COPY)
				.filter(([, copy]) => copy === legacyCopy())
				.map(([reason]) => reason),
		).toEqual(['no-purchase'])
	})
})
