import { describe, expect, it } from 'vitest'

import {
	DENIED_QUERY_REASONS,
	deniedRedirectPath,
	parseDeniedReason,
	LESSON_DENIAL_COPY,
	lessonDenialReason,
	type LessonDenialReason,
} from './lesson-denial'

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

	it('every reason has distinct copy', () => {
		const copies = Object.values(LESSON_DENIAL_COPY)
		expect(new Set(copies).size).toBe(copies.length)
	})
})

describe('denied redirect', () => {
	it('only whitelisted reasons survive the query string', () => {
		expect(parseDeniedReason('region-restricted')).toBe('region-restricted')
		for (const bad of [
			'pending-open',
			'<b>x</b>',
			'',
			null,
			undefined,
			'constructor',
		])
			expect(parseDeniedReason(bad)).toBeNull()
	})
	it('builds the module path with the reason, pending-open stays bare', () => {
		expect(deniedRedirectPath('crash-course', 'signed-out')).toBe(
			'/workshops/crash-course?denied=signed-out',
		)
		expect(deniedRedirectPath('crash-course', 'pending-open')).toBe(
			'/workshops/crash-course',
		)
	})
	it('every redirect reason round-trips through the whitelist', () => {
		for (const reason of DENIED_QUERY_REASONS)
			expect(parseDeniedReason(reason)).toBe(reason)
	})
})
