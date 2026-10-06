import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { readKitExitMembership } from '../../scripts/held-exit-kit-scan'
import { createHeldRecoveryPorts } from '../../scripts/held-exit-recover-runtime'
import { NEWSLETTER_EXIT_CONFIRMED_EVENT } from '../inngest/events/newsletter-exit'
import { mapDrovrShadowFact } from '../lib/subscriber-marketing/drovr-shadow-emitter'
import { buildDrovrSignupRequest } from '../lib/subscriber-marketing/drovr-doi-signup'
import {
	parseHeldRecoveryArgs,
	runHeldRecoveryCommand,
	resolveRecoveryContact,
	runHeldExitRecovery,
	type RecoveryRuntime,
} from '../../scripts/held-exit-recover'
import type { SideEffectIntent } from '../lib/subscriber-marketing/types'
import { InMemorySubscriberMarketingRepository } from '../lib/subscriber-marketing/dry-run'
import {
	readOldSequenceMembership,
	OLD_NEWSLETTER_EXIT_CONFIRMED,
	OLD_NEWSLETTER_REFERENCE,
} from '../lib/subscriber-marketing/old-newsletter-exit'
import type { ContactRecord } from '../lib/subscriber-marketing/types'

const contact: ContactRecord = {
	id: 'fixture-contact',
	email: 'fixture@example.test',
	name: 'Fixture',
	lifecycle: 'new',
	isProvisional: false,
	createdAt: '2026-10-06T12:00:00.000Z',
	updatedAt: '2026-10-06T12:00:00.000Z',
}

const held: SideEffectIntent = {
	id: 'fixture-row',
	contactId: contact.id,
	nextActionId: 'fixture-action',
	provider: 'kit',
	type: 'subscribe-evergreen-list',
	status: 'held-for-exit',
	idempotencyKey: `contact:${contact.id}:evergreen:list:shadow-newsletter`,
	createdAt: contact.createdAt,
	gates: [],
	reviewReasons: ['old-newsletter-exit-unconfirmed'],
	metadata: {
		list: 'shadow-newsletter',
		source: 'drovr',
		drovr: {
			tenantId: 'org-aihero',
			journeyId: 'crash-course-evergreen-offer',
			intentKey: 'fixture-original-intent',
		},
	},
}
const scan = {
	membership: 'absent' as const,
	complete: true,
	sequenceId: 2625552,
	pages: 2,
	subscribers: 12,
	startedAt: contact.createdAt,
	completedAt: contact.createdAt,
}
function runtime(): RecoveryRuntime & {
	repository: InMemorySubscriberMarketingRepository
} {
	const repository = new InMemorySubscriberMarketingRepository()
	return {
		repository,
		approvalScope: 'fixture-scope',
		now: () => contact.createdAt,
		readback: async (row) => ({
			eventDerivable: Boolean(row.completedAt),
			outbox: [],
		}),
		currentMembership: async (id) => readOldSequenceMembership(repository, id),
		findContactById: async (id) => (id === contact.id ? contact : undefined),
		inspect: async () => ({
			rows: [structuredClone(held)],
			identities: [
				{ id: 'fixture-identity', contactId: contact.id, externalId: '123' },
			],
			history: repository.findContactEventsByType(
				contact.id,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			),
		}),
		scan: async () => scan,
		persist: vi.fn(async (input) => repository.createContactEvent(input)),
		notify: vi.fn(async () => 1),
	}
}
const dryRun = {
	mode: 'dry-run' as const,
	namespace: 'ai-hero' as const,
	contactId: contact.id,
}

describe('recovery runtime adapters', () => {
	it('uses real GET proof, existing receipt writer, exact replay event and original completion key', async () => {
		const repository = new InMemorySubscriberMarketingRepository()
		let row = structuredClone(held)
		const fetcher: typeof fetch = vi.fn(async (_url, init) => {
			if (init?.method === 'GET')
				return new Response(
					JSON.stringify({
						subscribers: [],
						pagination: { has_next_page: false },
					}),
				)
			const payload: unknown = JSON.parse(String(init?.body))
			const proof = repository.findContactEventsByType(
				contact.id,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			)[0]
			expect(proof).toBeDefined()
			expect(payload).toMatchObject({
				name: NEWSLETTER_EXIT_CONFIRMED_EVENT,
				data: { contactId: contact.id, receiptId: proof?.id },
			})
			return new Response(
				JSON.stringify({ status: 200, ids: ['fixture-notification'] }),
			)
		})
		const readOutbox = vi.fn(async (lookup: { idempotencyKey: string }) => {
			const mapped = mapDrovrShadowFact({
				kind: 'side-effect-intent-completed',
				intent: row,
			})
			expect(mapped[0]).toMatchObject({
				type: 'shadow.entered',
				idempotencyKey: lookup.idempotencyKey,
			})
			expect(lookup.idempotencyKey).toBe('completion:fixture-original-intent')
			return [{ status: 'delivered' as const, attempts: 1 }]
		})
		const ports = createHeldRecoveryPorts({
			repository: {
				findContactById: async () => contact,
				createContactEvent: (input) => repository.createContactEvent(input),
				findContactEventsByType: (id, type) =>
					repository.findContactEventsByType(id, type),
			},
			findRows: async () => [row],
			findKitIdentities: async () => [
				{ id: 'fixture-identity', contactId: contact.id, externalId: '123' },
			],
			readOutbox,
			apiKey: 'fixture-kit-key',
			eventKey: 'fixture-inngest-key',
			deploymentScope: 'fixture-database:production',
			fetch: fetcher,
			now: () => contact.createdAt,
		})
		const planned = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		if (!planned.planHash) throw new Error('Missing test plan')
		expect(fetcher).toHaveBeenCalledTimes(1)
		const requested = await Effect.runPromise(
			runHeldExitRecovery(
				{
					...dryRun,
					mode: 'write',
					approval: 'fixture-approval',
					planHash: planned.planHash,
				},
				ports,
			),
		)
		expect(requested.status).toBe('requested')
		expect(fetcher).toHaveBeenCalledTimes(3)
		row = { ...row, status: 'completed', completedAt: contact.createdAt }
		const readback = await Effect.runPromise(
			runHeldExitRecovery({ ...dryRun, mode: 'readback' }, ports),
		)
		expect(readback.readback?.completionDispatch).toBe('confirmed')
		expect(readback).toMatchObject({
			readback: {
				fingerprints: {
					originalIntentKey: createHash('sha256')
						.update('fixture-original-intent')
						.digest('hex'),
					completionKey: createHash('sha256')
						.update('completion:fixture-original-intent')
						.digest('hex'),
				},
			},
		})
		expect(readOutbox).toHaveBeenCalledOnce()
		expect(fetcher).toHaveBeenCalledTimes(3)
		for (const value of [
			contact.id,
			contact.email!,
			'fixture-notification',
			'fixture-kit-key',
			'fixture-inngest-key',
		])
			expect(JSON.stringify([planned, requested, readback])).not.toContain(
				value,
			)
	})
})

describe('recovery process boundary', () => {
	it('defaults to dry-run, accepts exactly one AIH or drovr identity, and closes the runtime', async () => {
		expect(parseHeldRecoveryArgs(['--contact-id', contact.id])).toEqual(dryRun)
		expect(parseHeldRecoveryArgs(['--drovr-contact-id', contact.id])).toEqual({
			...dryRun,
			namespace: 'drovr',
		})
		expect(
			parseHeldRecoveryArgs(['--contact-id', contact.id, '--readback']),
		).toEqual({ ...dryRun, mode: 'readback' })
		const close = vi.fn(async () => {})
		const load = vi.fn(async () => ({ runtime: runtime(), close }))
		expect(
			await Effect.runPromise(
				runHeldRecoveryCommand(['--contact-id', contact.id], load),
			),
		).toMatchObject({ status: 'planned' })
		expect(load).toHaveBeenCalledOnce()
		expect(close).toHaveBeenCalledOnce()
	})

	it.each([
		[],
		['--contact-id'],
		['--contact-id', contact.id, '--drovr-contact-id', contact.id],
		['--contact-id', contact.id, '--write'],
		[
			'--contact-id',
			contact.id,
			'--write',
			'--approval',
			'fixture',
			'--plan-hash',
			'wrong',
		],
		['--contact-id', contact.id, '--write', '--readback'],
		['--contact-id', contact.id, '--approval', 'fixture'],
		['--contact-id', contact.email!],
		['--unknown', 'private@example.test'],
	])(
		'refuses malformed argv without opening any clients: %j',
		async (...argv) => {
			const load = vi.fn(async () => ({
				runtime: runtime(),
				close: async () => {},
			}))
			const result = await Effect.runPromise(runHeldRecoveryCommand(argv, load))
			expect(result.status).toBe('refused')
			expect(load).not.toHaveBeenCalled()
			for (const value of [contact.id, contact.email!, 'private@example.test'])
				expect(JSON.stringify(result)).not.toContain(value)
		},
	)

	it('contains startup and cleanup errors in the same PII-free JSON envelope', async () => {
		const startup = await Effect.runPromise(
			runHeldRecoveryCommand(['--contact-id', contact.id], async () => {
				throw new Error(contact.email!)
			}),
		)
		expect(startup).toMatchObject({
			version: 1,
			status: 'refused',
			reason: 'runtime-unavailable',
		})
		const cleanup = await Effect.runPromise(
			runHeldRecoveryCommand(['--contact-id', contact.id], async () => ({
				runtime: runtime(),
				close: async () => {
					throw new Error(contact.email!)
				},
			})),
		)
		expect(cleanup).toMatchObject({
			version: 1,
			status: 'refused',
			reason: 'runtime-close-failed',
		})
		expect(JSON.stringify([startup, cleanup])).not.toContain(contact.email)
	})
})

describe('read-only Kit exit proof', () => {
	it('proves absence without the newer AbortSignal.any platform API', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
		Reflect.deleteProperty(AbortSignal, 'any')
		try {
			const result = await Effect.runPromise(
				readKitExitMembership({
					apiKey: 'fixture-key',
					subscriberId: '123',
					now: () => contact.createdAt,
					fetch: vi.fn(
						async () =>
							new Response(
								JSON.stringify({
									subscribers: [],
									pagination: { has_next_page: false },
								}),
							),
					),
				}),
			)
			expect(result).toMatchObject({ membership: 'absent', complete: true })
		} finally {
			if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor)
		}
	})

	it('refuses provider evidence when the per-request timeout aborts', async () => {
		const timeout = new AbortController()
		const timeoutFactory = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(timeout.signal)
		const fetcher: typeof fetch = vi.fn()
		const observed: AbortSignal[] = []
		vi.mocked(fetcher).mockImplementation(async (_url, init) => {
			const signal = init?.signal
			if (!signal) throw new Error('Expected request signal')
			observed.push(signal)
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
				timeout.abort(new DOMException('Fixture deadline', 'TimeoutError'))
			})
		})
		try {
			const result = await Effect.runPromise(
				Effect.either(
					readKitExitMembership({
						apiKey: 'fixture-key',
						subscriberId: '123',
						fetch: fetcher,
						now: () => contact.createdAt,
					}),
				),
			)
			expect(result).toMatchObject({
				_tag: 'Left',
				left: { reason: 'provider-unavailable' },
			})
			expect(observed[0]?.aborted).toBe(true)
			expect(observed[0]?.reason).toBe(timeout.signal.reason)
			expect(timeoutFactory).toHaveBeenCalledWith(15_000)
		} finally {
			timeoutFactory.mockRestore()
		}
	})

	it('aborts the active GET when the caller cancels the Effect', async () => {
		const caller = new AbortController()
		let began = () => {}
		const started = new Promise<void>((resolve) => {
			began = resolve
		})
		const observed: AbortSignal[] = []
		const fetcher: typeof fetch = vi.fn()
		vi.mocked(fetcher).mockImplementation(async (_url, init) => {
			const signal = init?.signal
			if (!signal) throw new Error('Expected request signal')
			observed.push(signal)
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
				began()
			})
		})
		const running = Effect.runPromise(
			readKitExitMembership({
				apiKey: 'fixture-key',
				subscriberId: '123',
				fetch: fetcher,
				now: () => contact.createdAt,
			}),
			{ signal: caller.signal },
		)
		const interrupted = expect(running).rejects.toBeDefined()
		await started
		caller.abort()
		await interrupted
		expect(observed[0]?.aborted).toBe(true)
	})
	it.each(['missing-cursor', 'loop', 'malformed', 'http', 'cap', 'late'])(
		'never converts %s scans into absence',
		async (scenario) => {
			const fetcher: typeof fetch = vi.fn(
				async () =>
					new Response(
						JSON.stringify(
							scenario === 'malformed'
								? { subscribers: [], pagination: {} }
								: {
										subscribers: [{ id: 456 }],
										pagination: {
											has_next_page: scenario !== 'late',
											end_cursor:
												scenario === 'missing-cursor' ? null : 'same-cursor',
										},
									},
						),
						{ status: scenario === 'http' ? 503 : 200 },
					),
			)
			let clockReads = 0
			const clock = () =>
				scenario === 'late' && ++clockReads > 2
					? '2026-10-06T12:06:00.000Z'
					: contact.createdAt
			const result = await Effect.runPromise(
				Effect.either(
					readKitExitMembership({
						apiKey: 'fixture-key',
						subscriberId: '123',
						fetch: fetcher,
						now: clock,
						maxPages: scenario === 'cap' ? 1 : 3,
					}),
				),
			)
			if (scenario === 'http')
				expect(result).toMatchObject({
					_tag: 'Left',
					left: { reason: 'provider-unavailable' },
				})
			else
				expect(result).toMatchObject({
					_tag: 'Right',
					right: { membership: 'unknown', complete: false },
				})
		},
	)

	it('refuses a subscriber found on a later page even when their global state is cancelled', async () => {
		const fetcher: typeof fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						subscribers: [{ id: 123, state: 'cancelled' }],
						pagination: { has_next_page: false },
					}),
				),
		)
		vi.mocked(fetcher).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					subscribers: [{ id: 456 }],
					pagination: { has_next_page: true, end_cursor: 'one' },
				}),
			),
		)
		const result = await Effect.runPromise(
			readKitExitMembership({
				apiKey: 'fixture-key',
				subscriberId: '123',
				fetch: fetcher,
				now: () => contact.createdAt,
			}),
		)
		expect(result.membership).toBe('present')
		const ports = runtime()
		ports.scan = async () => result
		expect(
			await Effect.runPromise(runHeldExitRecovery(dryRun, ports)),
		).toMatchObject({ status: 'refused', reason: 'old-sequence-member' })
		expect(ports.persist).not.toHaveBeenCalled()
	})
	it('establishes absence only after every status=all sequence page, stripping provider PII', async () => {
		const fetcher: typeof fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						subscribers: [
							{
								id: 456,
								email_address: 'private@example.test',
								first_name: 'Private',
							},
						],
						pagination: { has_next_page: false, end_cursor: null },
					}),
				),
		)
		vi.mocked(fetcher).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					subscribers: [{ id: 789 }],
					pagination: { has_next_page: true, end_cursor: 'cursor-one' },
				}),
			),
		)
		const result = await Effect.runPromise(
			readKitExitMembership({
				apiKey: 'fixture-key',
				subscriberId: '123',
				fetch: fetcher,
				now: () => contact.createdAt,
			}),
		)
		expect(result).toMatchObject({
			membership: 'absent',
			complete: true,
			sequenceId: 2625552,
			pages: 2,
			subscribers: 2,
		})
		expect(fetcher).toHaveBeenCalledTimes(2)
		const second = new URL(String(vi.mocked(fetcher).mock.calls[1]?.[0]))
		expect(second.searchParams.get('after')).toBe('cursor-one')
		for (const [url, init] of vi.mocked(fetcher).mock.calls) {
			expect(new URL(String(url)).pathname).toBe(
				'/v4/sequences/2625552/subscribers',
			)
			expect(new URL(String(url)).searchParams.get('status')).toBe('all')
			expect(init?.method).toBe('GET')
		}
		for (const value of [
			'private@example.test',
			'Private',
			'fixture-key',
			'cursor-one',
			'123',
			'456',
			'789',
		])
			expect(JSON.stringify(result)).not.toContain(value)
	})
})

describe('single-contact held exit recovery', () => {
	it('binds the approval hash to the execution environment, not only the contact snapshot', async () => {
		const ports = runtime()
		const planned = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		if (!planned.planHash) throw new Error('Missing test plan')
		ports.approvalScope = 'fixture-other-database-and-provider-account'
		const result = await Effect.runPromise(
			runHeldExitRecovery(
				{
					...dryRun,
					mode: 'write',
					approval: 'fixture-approval',
					planHash: planned.planHash,
				},
				ports,
			),
		)
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'plan-hash-mismatch',
		})
		expect(ports.persist).not.toHaveBeenCalled()
		expect(ports.notify).not.toHaveBeenCalled()
	})
	it.each(['stale-receipt', 'notification-error'])(
		'preserves proof-written evidence and refuses %s without claiming replay completed',
		async (scenario) => {
			const ports = runtime()
			const planned = await Effect.runPromise(
				runHeldExitRecovery(dryRun, ports),
			)
			if (!planned.planHash) throw new Error('Missing test plan')
			if (scenario === 'stale-receipt')
				ports.currentMembership = async () => 'present'
			else
				ports.notify = vi.fn(async () => {
					throw new Error(`private ${contact.email}`)
				})
			const result = await Effect.runPromise(
				runHeldExitRecovery(
					{
						...dryRun,
						mode: 'write',
						approval: 'fixture-approval',
						planHash: planned.planHash,
					},
					ports,
				),
			)
			expect(result).toMatchObject({
				status: 'refused',
				reason:
					scenario === 'stale-receipt'
						? 'receipt-not-current'
						: 'notification-unavailable',
				counts: { exitReceipts: 1, notifications: 0 },
			})
			expect(ports.persist).toHaveBeenCalledOnce()
			if (scenario === 'stale-receipt')
				expect(ports.notify).not.toHaveBeenCalled()
			expect(JSON.stringify(result)).not.toContain(contact.email)
		},
	)
	it.each(['absent', 'pending', 'delivered'])(
		'reads completion and %s outbox evidence without confusing an empty outbox with success',
		async (scenario) => {
			const ports = runtime()
			const state = await ports.inspect(contact.id)
			const completed = {
				...held,
				status: 'completed' as const,
				completedAt: contact.createdAt,
			}
			ports.inspect = async () => ({ ...state, rows: [completed] })
			ports.readback = vi.fn(async (row) => {
				expect(row.metadata.drovr).toMatchObject({
					intentKey: 'fixture-original-intent',
				})
				return {
					eventDerivable: true,
					outbox:
						scenario === 'absent'
							? []
							: [
									{
										status:
											scenario === 'delivered'
												? ('delivered' as const)
												: ('pending' as const),
										attempts: 1,
									},
								],
				}
			})
			ports.scan = vi.fn(async () => {
				throw new Error('Readback must not call Kit')
			})
			const result = await Effect.runPromise(
				runHeldExitRecovery({ ...dryRun, mode: 'readback' }, ports),
			)
			expect(result).toMatchObject({
				status: 'readback',
				readback: {
					rowStatus: 'completed',
					completedAt: contact.createdAt,
					completionEventDerivable: true,
					completionDispatch:
						scenario === 'delivered'
							? 'confirmed'
							: scenario === 'pending'
								? 'attempted'
								: 'unknown',
					outbox: {
						pending: scenario === 'pending' ? 1 : 0,
						delivered: scenario === 'delivered' ? 1 : 0,
						rejected: 0,
						held: 0,
					},
				},
			})
			expect(ports.scan).not.toHaveBeenCalled()
			expect(ports.persist).not.toHaveBeenCalled()
			expect(ports.notify).not.toHaveBeenCalled()
			for (const value of [
				contact.id,
				contact.email!,
				'fixture-original-intent',
			])
				expect(JSON.stringify(result)).not.toContain(value)
		},
	)
	it.each(['stale', 'future', 'bad-row', 'ambiguous-identity'])(
		'refuses unsafe %s write evidence',
		async (scenario) => {
			const ports = runtime()
			const original = await ports.inspect(contact.id)
			if (scenario === 'stale') ports.now = () => '2026-10-06T12:06:00.000Z'
			if (scenario === 'future')
				ports.scan = async () => ({
					...scan,
					startedAt: '2026-10-07T12:00:00.000Z',
					completedAt: '2026-10-07T12:00:00.000Z',
				})
			if (scenario === 'bad-row')
				original.rows[0] = { ...held, contactId: 'fixture-wrong-contact' }
			if (scenario === 'ambiguous-identity')
				original.identities.push({
					...original.identities[0]!,
					id: 'fixture-second-identity',
				})
			ports.inspect = async () => original
			const result = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
			expect(result).toMatchObject({
				status: 'refused',
				reason:
					scenario === 'ambiguous-identity'
						? 'identity-unproven'
						: scenario === 'bad-row'
							? 'invalid-held-row'
							: 'membership-unknown',
			})
			expect(ports.persist).not.toHaveBeenCalled()
			expect(ports.notify).not.toHaveBeenCalled()
		},
	)
	it('writes the established current exit proof before its replay notification, then refuses a recovered row', async () => {
		const ports = runtime()
		const planned = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		if (!planned.planHash) throw new Error('Missing test plan')
		ports.notify = vi.fn(async ({ contactId, receiptId }) => {
			const proofs = ports.repository.findContactEventsByType(
				contactId,
				OLD_NEWSLETTER_EXIT_CONFIRMED,
			)
			expect(proofs).toHaveLength(1)
			expect(proofs[0]).toMatchObject({
				id: receiptId,
				provider: 'kit',
				providerReference: OLD_NEWSLETTER_REFERENCE,
				occurredAt: scan.startedAt,
			})
			expect(await readOldSequenceMembership(ports.repository, contactId)).toBe(
				'exited',
			)
			return 1
		})
		const write = {
			...dryRun,
			mode: 'write' as const,
			approval: 'fixture-approval',
			planHash: planned.planHash,
		}
		const result = await Effect.runPromise(runHeldExitRecovery(write, ports))
		expect(result).toMatchObject({
			status: 'requested',
			counts: { exitReceipts: 1, notifications: 1 },
		})
		expect(ports.notify).toHaveBeenCalledOnce()
		const original = await ports.inspect(contact.id)
		ports.inspect = async () => ({
			...original,
			rows: [{ ...held, status: 'completed', completedAt: contact.createdAt }],
		})
		expect(
			await Effect.runPromise(runHeldExitRecovery(write, ports)),
		).toMatchObject({ status: 'refused', reason: 'already-recovered' })
		expect(ports.persist).toHaveBeenCalledOnce()
		expect(ports.notify).toHaveBeenCalledOnce()
		for (const privateValue of [
			contact.id,
			contact.email!,
			contact.name!,
			'fixture-approval',
		])
			expect(JSON.stringify(result)).not.toContain(privateValue)
	})

	it.each(['approval', 'hash', 'member-after-plan', 'changed-after-scan'])(
		'requires fresh matching write authorization: %s',
		async (scenario) => {
			const ports = runtime()
			const planned = await Effect.runPromise(
				runHeldExitRecovery(dryRun, ports),
			)
			if (!planned.planHash) throw new Error('Missing test plan')
			if (scenario === 'member-after-plan')
				ports.scan = async () => ({ ...scan, membership: 'present' })
			if (scenario === 'changed-after-scan') {
				const original = await ports.inspect(contact.id)
				let reads = 0
				ports.inspect = async () =>
					++reads === 1
						? original
						: { ...original, rows: [{ ...held, status: 'pending' }] }
			}
			const result = await Effect.runPromise(
				runHeldExitRecovery(
					{
						...dryRun,
						mode: 'write',
						approval: scenario === 'approval' ? '' : 'fixture-approval',
						planHash: scenario === 'hash' ? '0'.repeat(64) : planned.planHash,
					},
					ports,
				),
			)
			expect(result).toMatchObject({
				status: 'refused',
				reason:
					scenario === 'approval'
						? 'approval-required'
						: scenario === 'hash'
							? 'plan-hash-mismatch'
							: scenario === 'member-after-plan'
								? 'old-sequence-member'
								: 'snapshot-changed',
			})
			expect(ports.persist).not.toHaveBeenCalled()
			expect(ports.notify).not.toHaveBeenCalled()
		},
	)
	it.each([
		['zero', 'held-row-count'],
		['multiple', 'held-row-count'],
		['mixed-targets', 'held-row-count'],
		['unknown', 'membership-unknown'],
		['partial', 'membership-unknown'],
		['member', 'old-sequence-member'],
		['error', 'provider-unavailable'],
		['recovered', 'already-recovered'],
		['wrong-sequence', 'membership-unknown'],
	])('refuses %s evidence without any writes', async (scenario, reason) => {
		const ports = runtime()
		const original = await ports.inspect(contact.id)
		if (scenario === 'zero') original.rows = []
		if (scenario === 'multiple')
			original.rows.push({ ...held, id: 'fixture-other-row' })
		if (scenario === 'mixed-targets')
			original.rows.push({
				...held,
				id: 'fixture-other-row',
				status: 'completed',
				completedAt: contact.createdAt,
			})
		if (scenario === 'recovered')
			original.rows = [
				{ ...held, status: 'completed', completedAt: contact.createdAt },
			]
		ports.inspect = async () => original
		if (scenario === 'unknown')
			ports.scan = async () => ({ ...scan, membership: 'unknown' })
		if (scenario === 'partial')
			ports.scan = async () => ({ ...scan, complete: false })
		if (scenario === 'member')
			ports.scan = async () => ({ ...scan, membership: 'present' })
		if (scenario === 'wrong-sequence')
			ports.scan = async () => ({ ...scan, sequenceId: 2757199 })
		if (scenario === 'error')
			ports.scan = async () => {
				throw new Error(`private ${contact.email}`)
			}
		for (const args of [
			dryRun,
			{
				...dryRun,
				mode: 'write' as const,
				approval: 'fixture-approval',
				planHash: '0'.repeat(64),
			},
		]) {
			const result = await Effect.runPromise(runHeldExitRecovery(args, ports))
			expect(result).toMatchObject({
				status: 'refused',
				reason,
				counts: { exitReceipts: 0, notifications: 0 },
			})
			expect(ports.persist).not.toHaveBeenCalled()
			expect(ports.notify).not.toHaveBeenCalled()
			expect(JSON.stringify(result)).not.toContain(contact.email)
		}
	})
	it('plans one receipt and one replay wakeup without writing or exposing contact data', async () => {
		const ports = runtime()
		const result = await Effect.runPromise(runHeldExitRecovery(dryRun, ports))
		expect(result).toMatchObject({
			version: 1,
			status: 'planned',
			counts: { exitReceipts: 1, notifications: 1 },
			checks: {
				contactResolved: true,
				exactlyOneHeld: true,
				oldSequenceAbsent: true,
			},
		})
		expect(result.planHash).toMatch(/^[a-f0-9]{64}$/)
		expect(result.scans).toEqual([scan])
		expect(ports.persist).not.toHaveBeenCalled()
		expect(ports.notify).not.toHaveBeenCalled()
		const output = JSON.stringify(result)
		for (const privateValue of [
			contact.id,
			contact.email!,
			contact.name!,
			held.id,
			'fixture-identity',
			'fixture-original-intent',
		])
			expect(output).not.toContain(privateValue)
	})
	it('resolves drovr delivery identity to the same AI Hero contact used by the executor', async () => {
		const delivered = buildDrovrSignupRequest({
			contactId: contact.id,
			drovrFormId: 'fixture-form',
			occurredAt: contact.createdAt,
			submissionId: 'fixture-submission',
			page: '/fixture',
		})
		const find = async (id: string) => (id === contact.id ? contact : undefined)
		expect(
			await resolveRecoveryContact(
				{ namespace: 'drovr', contactId: delivered.contactId },
				find,
			),
		).toEqual(contact)
		expect(
			await resolveRecoveryContact(
				{ namespace: 'ai-hero', contactId: contact.id },
				find,
			),
		).toEqual(contact)
	})
})
