import { describe, expect, it } from 'vitest'

import {
	differentAccountCopy,
	isPurchaseOwner,
	maskEmail,
	purchaseViewerState,
	thanksViewerState,
} from './purchase-viewer'

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

describe('isPurchaseOwner', () => {
	const base = {
		viewerUserId: 'u1',
		viewerEmail: 'Owner@Example.test',
		purchaseOwnerId: 'u2',
		purchaseEmail: 'owner@example.test',
	}
	it('matches on user id', () => {
		expect(
			isPurchaseOwner({
				...base,
				purchaseOwnerId: 'u1',
				purchaseEmail: 'x@y.z',
			}),
		).toBe(true)
	})
	it('matches on purchase email, case-insensitive, when ids differ', () => {
		expect(isPurchaseOwner(base)).toBe(true)
		expect(purchaseViewerState({ ...base, purchaseExists: true })).toBe('owner')
	})
	it('matches neither', () => {
		expect(
			isPurchaseOwner({ ...base, purchaseEmail: 'else@example.test' }),
		).toBe(false)
		expect(
			isPurchaseOwner({ ...base, viewerUserId: null, viewerEmail: null }),
		).toBe(false)
	})
})
