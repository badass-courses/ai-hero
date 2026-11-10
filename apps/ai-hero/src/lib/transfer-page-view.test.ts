import { describe, expect, it } from 'vitest'

import { TRANSFER_STATES } from '@/purchase-transfer/transfer-lifecycle'

import { TRANSFER_STILL_WAITING } from './acceptance-link-view'
import {
	ACCEPTANCE_STATE_OF_TRANSFER,
	transferDenialNotice,
	transferPageView,
} from './transfer-page-view'

describe('transfer denial notice', () => {
	it('shows the team-seat refusal with a support line', () => {
		expect(transferDenialNotice('included_team_purchase')).toBe(
			'Team orders and redeemed seats cannot be transferred. Email support@aihero.dev for help.',
		)
	})

	it('leaves not_authenticated to the sign-in view', () => {
		expect(transferDenialNotice('not_authenticated')).toBeNull()
	})

	it('shows nothing for a missing or unknown code', () => {
		expect(transferDenialNotice(undefined)).toBeNull()
		expect(transferDenialNotice('')).toBeNull()
		expect(transferDenialNotice('<script>')).toBeNull()
		expect(transferDenialNotice('toString')).toBeNull()
	})
})

const base = {
	purchaseMoved: false,
	clockExpired: false,
	viewer: 'signed-out' as const,
	linkUsed: true,
}

describe('transfer page view', () => {
	it('maps every stored transfer state', () => {
		expect(Object.keys(ACCEPTANCE_STATE_OF_TRANSFER).sort()).toEqual(
			[...TRANSFER_STATES].sort(),
		)
	})

	it.each([
		'CANCELED',
		'EXPIRED',
		'COMPLETED',
		'CONFIRMED',
		'AVAILABLE',
	] as const)(
		'a %s transfer never says still waiting, for any viewer, link used or not',
		(transferState) => {
			for (const viewer of ['signed-out', 'recipient', 'other'] as const)
				for (const linkUsed of [true, false]) {
					const view = transferPageView({
						...base,
						transferState,
						viewer,
						linkUsed,
					})
					expect(view.notice).toBeNull()
					expect(view.kind).not.toBe('accept')
				}
		},
	)

	it('a canceled transfer, signed out, with ?link=used says canceled', () => {
		expect(transferPageView({ ...base, transferState: 'CANCELED' })).toEqual({
			kind: 'canceled',
			notice: null,
		})
	})

	it('an INITIATED transfer past its time is expired, not waiting', () => {
		expect(
			transferPageView({
				...base,
				transferState: 'INITIATED',
				clockExpired: true,
			}),
		).toEqual({ kind: 'expired', notice: null })
	})

	it('a moved purchase reads accepted even if the row later says EXPIRED or CANCELED', () => {
		for (const transferState of ['EXPIRED', 'CANCELED'] as const)
			expect(
				transferPageView({ ...base, transferState, purchaseMoved: true }).kind,
			).toBe('accepted')
	})

	it('a VERIFIED claim past the clock still lets the recipient accept', () => {
		expect(
			transferPageView({
				...base,
				transferState: 'VERIFIED',
				clockExpired: true,
				viewer: 'recipient',
				linkUsed: false,
			}).kind,
		).toBe('accept')
	})

	it('a VERIFIED claim whose purchase moved is accepted', () => {
		expect(
			transferPageView({
				...base,
				transferState: 'VERIFIED',
				purchaseMoved: true,
			}).kind,
		).toBe('accepted')
	})

	it('a pending transfer on a spent link is still waiting', () => {
		for (const viewer of ['signed-out', 'recipient'] as const)
			expect(
				transferPageView({ ...base, transferState: 'INITIATED', viewer })
					.notice,
			).toBe(TRANSFER_STILL_WAITING)
	})

	it('accept is offered only to the signed-in recipient of a pending transfer', () => {
		for (const transferState of TRANSFER_STATES)
			for (const viewer of ['signed-out', 'recipient', 'other'] as const) {
				const { kind } = transferPageView({
					...base,
					transferState,
					viewer,
					linkUsed: false,
				})
				expect(kind === 'accept').toBe(
					viewer === 'recipient' &&
						(transferState === 'INITIATED' || transferState === 'VERIFIED'),
				)
			}
	})

	it('another account on a pending transfer is asked to sign in as the recipient', () => {
		expect(
			transferPageView({
				...base,
				transferState: 'INITIATED',
				viewer: 'other',
			}),
		).toEqual({ kind: 'sign-in', notice: null })
	})
})
