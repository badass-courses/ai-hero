import { describe, expect, it } from 'vitest'

import {
	DROVR_VALUE_PATH_BULK_FREEZE,
	isValuePathBirth,
	valuePathBulkFreeze,
} from './drovr-bulk-freeze'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const at = (iso: string) => Date.parse(iso)

describe('row 201g: no bulk value-path births in the 201e window (the hawk, S2 guard 1)', () => {
	it('opens 10-18 at the latest and stays open until PR B sets its end', () => {
		expect(DROVR_VALUE_PATH_BULK_FREEZE).toEqual({
			from: '2026-10-18T00:00:00.000Z',
			until: null,
		})
		expect(valuePathBulkFreeze({}, at('2026-10-17T23:59:59.999Z')).frozen).toBe(
			false,
		)
		expect(valuePathBulkFreeze({}, at('2026-10-18T00:00:00.000Z')).frozen).toBe(
			true,
		)
		expect(valuePathBulkFreeze({}, at('2027-01-01T00:00:00.000Z')).frozen).toBe(
			true,
		)
	})

	it('closes at PR B once its instant is set', () => {
		const window = {
			from: '2026-10-18T00:00:00.000Z',
			until: '2026-10-25T16:00:00.000Z',
		}
		expect(
			valuePathBulkFreeze({}, at('2026-10-25T15:59:59.999Z'), window).frozen,
		).toBe(true)
		expect(
			valuePathBulkFreeze({}, at('2026-10-25T16:00:00.000Z'), window).frozen,
		).toBe(false)
	})

	it('starts early when PR A deploys before 10-18 (the flag)', () => {
		expect(
			valuePathBulkFreeze(
				{ AIH_DROVR_VALUE_PATH_BULK_FREEZE: 'on' },
				at('2026-10-10T00:00:00.000Z'),
			),
		).toEqual({
			frozen: true,
			reason: 'AIH_DROVR_VALUE_PATH_BULK_FREEZE is on',
		})
	})

	it("lets an import through only with the hawk's sign-off, and names it", () => {
		expect(
			valuePathBulkFreeze(
				{ AIH_DROVR_VALUE_PATH_BULK_SIGNOFF: ' hawk 2026-10-20 ' },
				at('2026-10-20T00:00:00.000Z'),
			),
		).toEqual({ frozen: false, signedOffBy: 'hawk 2026-10-20' })
		expect(
			valuePathBulkFreeze(
				{ AIH_DROVR_VALUE_PATH_BULK_SIGNOFF: '  ' },
				at('2026-10-20T00:00:00.000Z'),
			).frozen,
		).toBe(true)
	})

	it('refuses only value-path births', () => {
		const birth = (journeyId: string, type = 'contact.created') =>
			({ journeyId, type }) as DrovrShadowEvent
		expect(isValuePathBirth(birth('value-path-skills-course'))).toBe(true)
		expect(isValuePathBirth(birth('contact-directory'))).toBe(false)
		expect(isValuePathBirth(birth('crash-course-evergreen-offer'))).toBe(false)
		expect(isValuePathBirth(birth('shadow-newsletter'))).toBe(false)
		expect(
			isValuePathBirth(
				birth('value-path-skills-course', 'value-path.answer-selected'),
			),
		).toBe(false)
	})
})
