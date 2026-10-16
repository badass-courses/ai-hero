import { describe, expect, it } from 'vitest'

import {
	ACCEPTANCE_TOKEN_STATES,
	ACCEPTANCE_TRANSFER_STATES,
	ACCEPTANCE_VIEWERS,
	TRANSFER_STILL_WAITING,
	acceptanceLinkView,
	maskEmail,
	transferPathOf,
	type AcceptanceTokenState,
	type AcceptanceTransferState,
	type AcceptanceViewer,
} from './acceptance-link-view'

// The behavior before this change: a spent token always meant "login expired",
// whatever the transfer was doing.
const legacyMessage = (tokenState: AcceptanceTokenState) =>
	tokenState === 'spent' ? 'This login link expired.' : null

describe('acceptance email link', () => {
	it('legacy: a spent link on a pending transfer said expired', () => {
		expect(legacyMessage('spent')).toBe('This login link expired.')
	})

	it('a spent link on a pending transfer says it is still waiting, and goes to the transfer', () => {
		for (const signedIn of ['signed-out', 'recipient'] as const) {
			expect(
				acceptanceLinkView({
					tokenState: 'spent',
					signedIn,
					transferState: 'pending',
				}),
			).toMatchObject({ route: 'transfer', notice: TRANSFER_STILL_WAITING })
		}
	})

	it.each(['accepted', 'canceled', 'expired', 'unknown'] as const)(
		'a %s transfer is never called "still waiting"',
		(transferState) => {
			for (const signedIn of ACCEPTANCE_VIEWERS) {
				const view = acceptanceLinkView({
					tokenState: 'spent',
					signedIn,
					transferState,
				})
				expect(view.route).toBe('transfer')
				expect(view.notice).toBeNull()
				expect(view.mayAccept).toBe(false)
			}
		},
	)

	it('only the signed-in recipient of a pending transfer may accept', () => {
		for (const tokenState of ACCEPTANCE_TOKEN_STATES)
			for (const signedIn of ACCEPTANCE_VIEWERS)
				for (const transferState of ACCEPTANCE_TRANSFER_STATES) {
					const view = acceptanceLinkView({
						tokenState,
						signedIn,
						transferState,
					})
					expect(view.mayAccept).toBe(
						signedIn === 'recipient' && transferState === 'pending',
					)
				}
	})

	it('cross-account: signed in as someone else never accepts and gets no waiting notice', () => {
		const view = acceptanceLinkView({
			tokenState: 'spent',
			signedIn: 'other',
			transferState: 'pending',
		})
		expect(view).toEqual({ route: 'transfer', notice: null, mayAccept: false })
	})

	it('a valid token proceeds as before', () => {
		for (const signedIn of ACCEPTANCE_VIEWERS)
			for (const transferState of ACCEPTANCE_TRANSFER_STATES)
				expect(
					acceptanceLinkView({ tokenState: 'valid', signedIn, transferState }),
				).toMatchObject({ route: 'confirm', notice: null })
	})

	it('table is total', () => {
		let n = 0
		for (const t of ACCEPTANCE_TOKEN_STATES)
			for (const v of ACCEPTANCE_VIEWERS as readonly AcceptanceViewer[])
				for (const s of ACCEPTANCE_TRANSFER_STATES as readonly AcceptanceTransferState[]) {
					expect(
						acceptanceLinkView({
							tokenState: t,
							signedIn: v,
							transferState: s,
						}),
					).toBeDefined()
					n++
				}
		expect(n).toBe(30)
	})
})

describe('helpers', () => {
	it('maskEmail hides the name', () => {
		expect(maskEmail('pat@home.example')).toBe('p**@home.example')
		expect(maskEmail('nonsense')).toBe('***')
	})
	it('transferPathOf accepts only transfer pages', () => {
		expect(transferPathOf('/transfer/abc-123')).toBe('/transfer/abc-123')
		for (const p of [
			'/',
			'/transfer/',
			'/transfer/a/b',
			'//evil.example',
			'/welcome',
		])
			expect(transferPathOf(p)).toBeNull()
	})
})
