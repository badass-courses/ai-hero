import { describe, expect, it, vi } from 'vitest'
import { encodeHeldContinuationEnvelope } from './drovr-outbox-control'
import {
	settleProfileAckWorkerRows,
	type ProfileAckWorkerRow,
	type ProfileAckWorkerKey,
} from './contact-sync-profile-ack-worker'
import type { ProfileAckReference } from './contact-sync-profile-ack-schema'
import type { settleAndCompleteProfileAck } from './contact-sync-profile-ack-persistence'

const ref: ProfileAckReference = {
	target: 'production',
	endpoint: 'events',
	tenantId: 'org-aihero',
	contactId: 'synthetic-worker',
	journeyId: 'contact-directory',
	profileVersion: 3,
	coordinatorKey: '1'.repeat(64),
	requestId: '4'.repeat(64),
	request: { kind: 'delta' },
}
const row: ProfileAckWorkerRow = {
	target: ref.target,
	endpoint: ref.endpoint,
	tenantId: ref.tenantId,
	contactId: ref.contactId,
	journeyId: ref.journeyId,
	dedupeKey: '2'.repeat(64),
	eventType: 'contact.links.issued',
}
const metadata = () => ({
	target: row.target,
	dedupeKey: row.dedupeKey,
	heldContinuation: encodeHeldContinuationEnvelope({
		v: 1,
		profileAck: { v: 1, role: 'member', ref },
	}),
})
function fixture(rows: ProfileAckWorkerRow[] = [row]) {
	return {
		database: {},
		rows,
		receiverAccepted: true,
		enabled: vi.fn(async () => true),
		settle: vi.fn(
			async (
				_database: unknown,
				_keys?: readonly ProfileAckWorkerKey[],
				_coordinated?: boolean,
			) => 1,
		),
		readMetadata: vi.fn(async () => [metadata()]),
		complete: vi.fn(
			async (
				args: Parameters<typeof settleAndCompleteProfileAck>[0],
			): ReturnType<typeof settleAndCompleteProfileAck> => ({
				_tag: 'ProfileAckSettled',
				settled: await args.settle('synthetic-tx'),
				evaluation: {
					_tag: 'AckEvidenceExpired',
					v: 1,
					target: ref.target,
					contactId: ref.contactId,
					profileVersion: ref.profileVersion,
					requestId: ref.requestId,
				},
			}),
		),
	}
}
describe('worker native settlement and frozen ACK routing', () => {
	it.each(['signup', 'purchase', 'contact.unsubscribed'])(
		'keeps genuine %s independent of flag and control ports',
		async (eventType) => {
			const p = fixture([{ ...row, eventType }])
			expect(await settleProfileAckWorkerRows(p)).toEqual({
				settled: 1,
				acknowledgements: [],
			})
			expect(p.enabled).not.toHaveBeenCalled()
			expect(p.readMetadata).not.toHaveBeenCalled()
			expect(p.complete).not.toHaveBeenCalled()
			expect(p.settle).toHaveBeenCalledTimes(1)
			expect(p.settle).toHaveBeenCalledWith(p.database)
		},
	)
	it('does not consult the flag or ACK port for never-registered legacy profile rows', async () => {
		const p = fixture()
		p.readMetadata.mockResolvedValue([])
		expect(await settleProfileAckWorkerRows(p)).toEqual({
			settled: 1,
			acknowledgements: [],
		})
		expect(p.enabled).not.toHaveBeenCalled()
		expect(p.complete).not.toHaveBeenCalled()
	})
	it('passes only immutable routing identity to completion and settles inside its transaction', async () => {
		const p = fixture()
		const result = await settleProfileAckWorkerRows(p)
		expect(result.settled).toBe(1)
		expect(result.acknowledgements[0]).toMatchObject({
			_tag: 'ProfileAckSettled',
			evaluation: { _tag: 'AckEvidenceExpired' },
		})
		expect(p.complete).toHaveBeenCalledTimes(1)
		expect(p.complete.mock.calls[0]![0]).toMatchObject({
			ref,
			settledKeys: [row.dedupeKey],
			enabled: p.enabled,
		})
		expect(p.settle).toHaveBeenCalledTimes(1)
		expect(p.settle).toHaveBeenCalledWith(
			'synthetic-tx',
			[{ target: row.target, dedupeKey: row.dedupeKey }],
			true,
		)
	})
	it.each([true, false])(
		'never turns final/mixed refusal into delivered proof, including flag %s',
		async (enabled) => {
			const p = fixture()
			p.receiverAccepted = false
			p.enabled.mockResolvedValue(enabled)
			expect(await settleProfileAckWorkerRows(p)).toEqual({
				settled: 0,
				acknowledgements: [],
			})
			expect(p.settle).not.toHaveBeenCalled()
			expect(p.complete).not.toHaveBeenCalled()
		},
	)
	it('settles native debt but not ACK when the fresh completion gate switched OFF', async () => {
		const p = fixture()
		p.complete.mockResolvedValue({ _tag: 'ProfileAckDisabled' })
		expect(await settleProfileAckWorkerRows(p)).toMatchObject({
			settled: 1,
			acknowledgements: [{ _tag: 'ProfileAckDisabled' }],
		})
		expect(p.settle).toHaveBeenCalledTimes(1)
		expect(p.settle).toHaveBeenCalledWith(
			p.database,
			[{ target: row.target, dedupeKey: row.dedupeKey }],
			true,
		)
	})
	it('separately settles unrelated genuine rows without broadening the ACK callback', async () => {
		const genuine = { ...row, eventType: 'signup', dedupeKey: '3'.repeat(64) }
		const p = fixture([row, genuine])
		expect((await settleProfileAckWorkerRows(p)).settled).toBe(2)
		expect(p.settle.mock.calls).toEqual([
			[
				'synthetic-tx',
				[{ target: row.target, dedupeKey: row.dedupeKey }],
				true,
			],
			[p.database, [genuine]],
		])
	})
	it('refuses cross-contact or duplicate metadata before native mutation', async () => {
		for (const foreign of [true, false]) {
			const p = fixture()
			if (foreign) p.rows = [{ ...row, contactId: 'another-synthetic-contact' }]
			else p.readMetadata.mockResolvedValue([metadata(), metadata()])
			await expect(settleProfileAckWorkerRows(p)).rejects.toThrow(
				'ProfileAckConflict:',
			)
			expect(p.settle).not.toHaveBeenCalled()
			expect(p.complete).not.toHaveBeenCalled()
		}
	})
	it('refuses unbounded profile scopes without truncating or reading proof', async () => {
		const p = fixture(Array.from({ length: 1025 }, () => ({ ...row })))
		await expect(settleProfileAckWorkerRows(p)).rejects.toThrow('unbounded')
		expect(p.readMetadata).not.toHaveBeenCalled()
		expect(p.settle).not.toHaveBeenCalled()
	})
})
