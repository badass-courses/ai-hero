import { describe, expect, it } from 'vitest'

import {
	differentAccountCopy,
	maskEmail,
	purchaseViewerState,
	thanksViewerState,
} from './purchase-viewer'

// Legacy: welcome redirected home for everything but an owned purchase, and
// thanks showed full details to every non-owner.
const legacyWelcome = (owned: boolean) => (owned ? 'render' : 'redirect-home')
const legacyThanks = (isOwner: boolean) => (isOwner ? 'redirect' : 'details')

describe('purchaseViewerState', () => {
	const cases: [string | null, boolean, string | null, string][] = [
		[null, true, 'u1', 'anonymous'],
		[null, false, null, 'anonymous'],
		['u1', false, null, 'not-found'],
		['u1', true, 'u1', 'owner'],
		['u1', true, 'u2', 'different-account'],
		['u1', true, null, 'different-account'],
	]
	for (const [viewer, exists, owner, want] of cases)
		it(`viewer=${viewer} exists=${exists} owner=${owner} -> ${want}`, () => {
			expect(
				purchaseViewerState({
					viewerUserId: viewer,
					purchaseExists: exists,
					purchaseOwnerId: owner,
				}),
			).toBe(want)
		})

	it('legacy silently redirects the wrong account, new one says so', () => {
		expect(legacyWelcome(false)).toBe('redirect-home')
		expect(
			purchaseViewerState({
				viewerUserId: 'u1',
				purchaseExists: true,
				purchaseOwnerId: 'u2',
			}),
		).toBe('different-account')
	})
})

describe('thanksViewerState', () => {
	const cases: [string | null, boolean, string][] = [
		[null, false, 'anonymous'],
		[null, true, 'owner'],
		['u1', true, 'owner'],
		['u1', false, 'different-account'],
	]
	for (const [viewer, isOwner, want] of cases)
		it(`viewer=${viewer} owner=${isOwner} -> ${want}`, () => {
			expect(thanksViewerState({ viewerUserId: viewer, isOwner })).toBe(want)
		})

	it('legacy leaks details to a signed-in non-owner', () => {
		expect(legacyThanks(false)).toBe('details')
		expect(thanksViewerState({ viewerUserId: 'u1', isOwner: false })).toBe(
			'different-account',
		)
	})
})

describe('maskEmail', () => {
	it('masks the local part', () => {
		expect(maskEmail('someone@example.com')).toBe('so***@example.com')
		expect(maskEmail('a@example.com')).toBe('a***@example.com')
		expect(maskEmail('ab@example.com')).toBe('a***@example.com')
	})
	it('never echoes a missing or malformed address', () => {
		expect(maskEmail(null)).toBe('another account')
		expect(maskEmail('nope')).toBe('another account')
		expect(maskEmail('@x.com')).toBe('another account')
	})
	it('copy names the masked account only', () => {
		const copy = differentAccountCopy('someone@example.com')
		expect(copy.title).toContain('different account')
		expect(copy.description).toContain('so***@example.com')
		expect(copy.description).not.toContain('someone@')
	})
})
