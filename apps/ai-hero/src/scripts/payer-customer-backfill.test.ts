import {
	mkdir,
	mkdtemp,
	readFile,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/mysql-proxy'
import { describe, expect, it } from 'vitest'

import * as schema from '../db/schema'
import * as backfill from '../../scripts/payer-customer-backfill'
import * as runtime from '../../scripts/payer-customer-backfill-runtime'

type Backfill = typeof backfill
type Runtime = typeof runtime
type CustomerFacts = backfill.CustomerFacts
type PlanItem = backfill.PlanItem
type BackfillPorts = backfill.BackfillPorts
type JournalEntry = backfill.JournalEntry

// ---------------------------------------------------------------- facts ----

const T0 = new Date('2026-03-01T00:00:00Z')
const sec = (offsetSeconds: number) => T0.getTime() / 1000 + offsetSeconds
const DAY = 86400

const userA = { id: 'user-a', email: 'a@example.test', name: 'Payer A' }
const userB = { id: 'user-b', email: 'b@example.test', name: 'Holder B' }
const userC = { id: 'user-c', email: 'c@example.test', name: 'Holder C' }
const quiet = {
	deleted: false,
	email: 'b@example.test',
	name: 'Holder B',
	chargeCreated: [sec(-DAY)],
	paymentIntentCreated: [sec(-DAY)],
	paymentMethodCreated: [sec(-DAY)],
	invoiceCreated: [sec(-DAY)],
	chargeDisputed: false,
	subscriptions: [],
}
const transfer = (
	id: string,
	from: string,
	at: Date | null,
	state = 'COMPLETED',
) => ({
	id,
	state,
	sourceUserId: from,
	completedAt: at,
	createdAt: at,
})

/** Pre-fix shape: A paid, A transferred to B, the customer follows B. */
function facts(over: Partial<CustomerFacts> = {}): CustomerFacts {
	return {
		customerId: 'mcu-1',
		stripeCustomerId: 'cus_1',
		holderUserId: userB.id,
		purchases: [
			{
				purchaseId: 'pur-1',
				chargeUserId: userB.id,
				openDispute: false,
				transfers: [transfer('put-1', userA.id, T0)],
			},
		],
		users: { [userA.id]: userA, [userB.id]: userB, [userC.id]: userC },
		activeSubscriptionRows: 0,
		stripe: { ...quiet },
		...over,
	}
}
const withStripe = (stripe: Partial<CustomerFacts['stripe']>) =>
	facts({ stripe: { ...quiet, ...stripe } })

type Scenario = {
	name: string
	facts: CustomerFacts
	decision: PlanItem['decision']
	reason: PlanItem['reason']
	payer?: string | null
}
const chain = (): CustomerFacts['purchases'] => [
	{
		purchaseId: 'pur-1',
		chargeUserId: userC.id,
		openDispute: false,
		transfers: [
			transfer('put-2', userB.id, new Date(T0.getTime() + DAY * 1000)),
			transfer('put-1', userA.id, T0),
		],
	},
]

const scenarios: Scenario[] = [
	{
		name: 'pre-fix transfer',
		facts: facts(),
		decision: 'move',
		reason: null,
		payer: userA.id,
	},
	{
		name: 'use before the transfer does not block',
		facts: withStripe({
			chargeCreated: [sec(-5 * DAY)],
			paymentMethodCreated: [sec(-5 * DAY)],
		}),
		decision: 'move',
		reason: null,
	},
	{
		name: 'chain A to B to C pays A',
		facts: facts({ holderUserId: userC.id, purchases: chain() }),
		decision: 'move',
		reason: null,
		payer: userA.id,
	},
	{
		name: 'post-fix transfer: customer never left the payer',
		facts: facts({
			holderUserId: userA.id,
			purchases: [
				{
					purchaseId: 'pur-1',
					chargeUserId: userA.id,
					openDispute: false,
					transfers: [transfer('put-1', userA.id, T0)],
				},
			],
		}),
		decision: 'skip',
		reason: 'already-on-payer',
	},
	{
		name: 'no transfer at all',
		facts: facts({
			purchases: [
				{
					purchaseId: 'p',
					chargeUserId: userB.id,
					openDispute: false,
					transfers: [],
				},
			],
		}),
		decision: 'skip',
		reason: 'no-completed-transfer',
	},
	{
		name: 'only unfinished transfers',
		facts: facts({
			purchases: [
				{
					purchaseId: 'p',
					chargeUserId: userB.id,
					openDispute: false,
					transfers: [transfer('t', userA.id, T0, 'INITIATED')],
				},
			],
		}),
		decision: 'skip',
		reason: 'no-completed-transfer',
	},
	{
		name: 'payers disagree across purchases',
		facts: facts({
			purchases: [
				...facts().purchases,
				{
					purchaseId: 'pur-2',
					chargeUserId: userB.id,
					openDispute: false,
					transfers: [],
				},
			],
		}),
		decision: 'skip',
		reason: 'ambiguous-payer',
	},
	{
		name: 'completed transfer with no timestamp',
		facts: facts({
			purchases: [
				{
					purchaseId: 'p',
					chargeUserId: userB.id,
					openDispute: false,
					transfers: [transfer('t', userA.id, null)],
				},
			],
		}),
		decision: 'skip',
		reason: 'ambiguous-payer',
	},
	{
		name: 'payer user missing',
		facts: facts({ users: { [userB.id]: userB } }),
		decision: 'skip',
		reason: 'payer-user-missing',
	},
	{
		name: 'holder user missing',
		facts: facts({ users: { [userA.id]: userA } }),
		decision: 'skip',
		reason: 'holder-user-missing',
	},
	{
		name: 'stripe customer deleted',
		facts: withStripe({ deleted: true }),
		decision: 'skip',
		reason: 'stripe-customer-deleted',
	},
	{
		name: 'open dispute',
		facts: facts({
			purchases: [{ ...facts().purchases[0]!, openDispute: true }],
		}),
		decision: 'carve-out',
		reason: 'open-dispute',
	},
	{
		name: 'active stripe subscription',
		facts: withStripe({
			subscriptions: [{ created: sec(-DAY), status: 'active' }],
		}),
		decision: 'carve-out',
		reason: 'active-subscription',
	},
	{
		name: 'active subscription row',
		facts: facts({ activeSubscriptionRows: 1 }),
		decision: 'carve-out',
		reason: 'active-subscription',
	},
	{
		name: 'charge after the transfer',
		facts: withStripe({ chargeCreated: [sec(60)] }),
		decision: 'carve-out',
		reason: 'holder-charge-after-transfer',
	},
	{
		name: 'payment intent after the transfer',
		facts: withStripe({ paymentIntentCreated: [sec(60)] }),
		decision: 'carve-out',
		reason: 'holder-payment-intent-after-transfer',
	},
	{
		name: 'saved payment method after the transfer',
		facts: withStripe({ paymentMethodCreated: [sec(60)] }),
		decision: 'carve-out',
		reason: 'holder-payment-method-after-transfer',
	},
	{
		name: 'canceled subscription created after the transfer',
		facts: withStripe({
			subscriptions: [{ created: sec(60), status: 'canceled' }],
		}),
		decision: 'carve-out',
		reason: 'holder-subscription-after-transfer',
	},
	{
		name: 'canceled subscription from before the transfer moves',
		facts: withStripe({
			subscriptions: [{ created: sec(-DAY), status: 'canceled' }],
		}),
		decision: 'move',
		reason: null,
	},
	{
		name: 'chain: use after the FIRST transfer carves out',
		facts: facts({
			holderUserId: userC.id,
			purchases: chain(),
			stripe: { ...quiet, chargeCreated: [sec(DAY / 2)] },
		}),
		decision: 'carve-out',
		reason: 'holder-charge-after-transfer',
	},
	{
		name: 'stripe charge disputed',
		facts: withStripe({ chargeDisputed: true }),
		decision: 'carve-out',
		reason: 'stripe-charge-disputed',
	},
	{
		name: 'invoice after the transfer',
		facts: withStripe({ invoiceCreated: [sec(60)] }),
		decision: 'carve-out',
		reason: 'holder-invoice-after-transfer',
	},
	{
		name: 'same-second charge counts as after',
		facts: withStripe({ chargeCreated: [sec(0)] }),
		decision: 'carve-out',
		reason: 'holder-charge-after-transfer',
	},
	{
		name: 'charge at the start of the second of a mid-second transfer',
		facts: facts({
			stripe: { ...quiet, chargeCreated: [sec(0)] },
			purchases: [
				{
					purchaseId: 'p',
					chargeUserId: userA.id,
					openDispute: false,
					transfers: [transfer('t', userA.id, new Date(T0.getTime() + 500))],
				},
			],
		}),
		decision: 'carve-out',
		reason: 'holder-charge-after-transfer',
	},
	{
		name: 'charge one second before the transfer moves',
		facts: withStripe({ chargeCreated: [sec(-1)] }),
		decision: 'move',
		reason: null,
	},
	{
		name: 'transfer dated by createdAt only',
		facts: facts({
			purchases: [
				{
					purchaseId: 'p',
					chargeUserId: userB.id,
					openDispute: false,
					transfers: [
						{
							id: 't',
							state: 'COMPLETED',
							sourceUserId: userA.id,
							completedAt: null,
							createdAt: T0,
						},
					],
				},
			],
		}),
		decision: 'move',
		reason: null,
	},
	{
		name: 'payer with no name still moves',
		facts: facts({
			users: { [userA.id]: { ...userA, name: null }, [userB.id]: userB },
		}),
		decision: 'move',
		reason: null,
	},
	// Precedence: ambiguous and missing before carve-out, carve-out before move.
	{
		name: 'ambiguous beats carve-out',
		facts: facts({
			purchases: [
				...facts().purchases,
				{
					purchaseId: 'pur-2',
					chargeUserId: userB.id,
					openDispute: true,
					transfers: [],
				},
			],
			stripe: { ...quiet, chargeCreated: [sec(60)] },
		}),
		decision: 'skip',
		reason: 'ambiguous-payer',
	},
	{
		name: 'payer missing beats carve-out',
		facts: facts({
			users: { [userB.id]: userB },
			stripe: { ...quiet, chargeCreated: [sec(60)] },
		}),
		decision: 'skip',
		reason: 'payer-user-missing',
	},
	{
		name: 'deleted stripe customer beats carve-out',
		facts: facts({
			activeSubscriptionRows: 1,
			stripe: { ...quiet, deleted: true },
		}),
		decision: 'skip',
		reason: 'stripe-customer-deleted',
	},
	{
		name: 'already on payer beats carve-out',
		facts: facts({ holderUserId: userA.id, activeSubscriptionRows: 1 }),
		decision: 'skip',
		reason: 'already-on-payer',
	},
	{
		name: 'dispute beats the usage reasons',
		facts: facts({
			purchases: [{ ...facts().purchases[0]!, openDispute: true }],
			stripe: { ...quiet, chargeCreated: [sec(60)] },
		}),
		decision: 'carve-out',
		reason: 'open-dispute',
	},
]

// ------------------------------------------------------- invariant suite ----

/** Independent oracle: did the holder use the customer after the transfer? */
function oracleUsed(f: CustomerFacts): boolean {
	const times = f.purchases.flatMap((p) =>
		p.transfers
			.filter((t) => t.state === 'COMPLETED')
			.map((t) => (t.completedAt ?? t.createdAt)!.getTime()),
	)
	// Independent of the code's floor: an object created in the same second
	// as the transfer (created * 1000 + 999 >= completedMs) counts as after.
	const completedMs = Math.min(...times)
	return (
		f.purchases.some((p) => p.openDispute) ||
		f.stripe.chargeDisputed ||
		f.activeSubscriptionRows > 0 ||
		f.stripe.subscriptions.some(
			(s) => !['canceled', 'incomplete_expired'].includes(s.status),
		) ||
		[
			...f.stripe.chargeCreated,
			...f.stripe.paymentIntentCreated,
			...f.stripe.paymentMethodCreated,
			...f.stripe.invoiceCreated,
			...f.stripe.subscriptions.map((s) => s.created),
		].some((created) => created * 1000 + 999 >= completedMs)
	)
}

function rng(seed: number) {
	let s = seed
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296
	}
}
function randomFacts(next: () => number): CustomerFacts {
	const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!
	// 15% land exactly on the first transfer's second, to hit the boundary.
	const near = () =>
		next() < 0.15 ? sec(0) : sec(Math.floor((next() - 0.5) * 4 * DAY))
	const many = (n: number) =>
		Array.from({ length: Math.floor(next() * n) }, near)
	const holder = pick([userA.id, userB.id, userC.id])
	const purchases = Array.from(
		{ length: 1 + Math.floor(next() * 2) },
		(_, i) => {
			const hops = Math.floor(next() * 3)
			const sources = [userA.id, userB.id, userC.id]
			return {
				purchaseId: `p${i}`,
				chargeUserId: pick([userA.id, userB.id, userC.id]),
				openDispute: next() < 0.1,
				transfers: Array.from({ length: hops }, (_, h) =>
					transfer(
						`t${i}-${h}`,
						sources[h]!,
						next() < 0.05
							? null
							: new Date(
									T0.getTime() +
										Math.floor(next() * 3) * DAY * 1000 +
										Math.floor(next() * 1000),
								),
						pick(['COMPLETED', 'COMPLETED', 'INITIATED', 'CANCELED']),
					),
				),
			}
		},
	)
	return {
		customerId: 'mcu-r',
		stripeCustomerId: 'cus_r',
		holderUserId: holder,
		purchases,
		users:
			next() < 0.1
				? { [userB.id]: userB }
				: { [userA.id]: userA, [userB.id]: userB, [userC.id]: userC },
		activeSubscriptionRows: next() < 0.1 ? 1 : 0,
		stripe: {
			deleted: next() < 0.05,
			email: null,
			name: null,
			chargeCreated: many(3),
			paymentIntentCreated: many(3),
			paymentMethodCreated: many(3),
			invoiceCreated: many(2),
			chargeDisputed: next() < 0.05,
			subscriptions: Array.from({ length: Math.floor(next() * 2) }, () => ({
				created: near(),
				status: pick(['active', 'canceled', 'past_due']),
			})),
		},
	}
}

// ---- In-memory world for the write path -----------------------------------

class Crash extends Error {}
type CrashPoint = 'after-cas' | 'after-stripe' | 'after-journal'
type World = {
	userIds: Map<string, string>
	stripe: Map<string, { email: string; name: string | null; applied: number }>
	keys: Map<string, true>
	unkeyedWrites: number
	journal: JournalEntry[]
	calls: string[]
	/** Users on an unexpired INITIATED, VERIFIED or CONFIRMED transfer. */
	openUsers: Set<string>
	/** Per-customer holder and payer, default holder B and payer A. */
	shape: Shape[]
	stop: boolean
	crashed: boolean
	/** Extra Stripe charge times on a customer: usage that appears later. */
	usage: Map<string, number[]>
	/** Customers whose fresh read returns the old holder (a read/CAS race). */
	stale: Set<string>
	payerName: string | null
}

type Shape = { holder: string; payer: string }
const defaultShape = (count: number): Shape[] =>
	Array.from({ length: count }, () => ({ holder: userB.id, payer: userA.id }))

function writeFacts(
	count: number,
	payerName: string | null = userA.name,
	shape: Shape[] = defaultShape(count),
): CustomerFacts[] {
	return Array.from({ length: count }, (_, i) =>
		facts({
			customerId: `mcu-${i}`,
			stripeCustomerId: `cus_${i}`,
			holderUserId: shape[i]!.holder,
			purchases: [
				{
					purchaseId: 'pur-1',
					chargeUserId: shape[i]!.holder,
					openDispute: false,
					transfers: [transfer('put-1', shape[i]!.payer, T0)],
				},
			],
			users: {
				[userA.id]: { ...userA, name: payerName },
				[userB.id]: userB,
				[userC.id]: userC,
			},
		}),
	)
}

function newWorld(count: number, shape = defaultShape(count)): World {
	return {
		shape,
		userIds: new Map(
			Array.from({ length: count }, (_, i) => [`mcu-${i}`, shape[i]!.holder]),
		),
		stripe: new Map(
			Array.from({ length: count }, (_, i) => [
				`cus_${i}`,
				{ email: userB.email, name: userB.name, applied: 0 },
			]),
		),
		keys: new Map(),
		unkeyedWrites: 0,
		journal: [],
		calls: [],
		openUsers: new Set(),
		stop: false,
		crashed: false,
		usage: new Map(),
		stale: new Set(),
		payerName: userA.name,
	}
}

function portsFor(
	world: World,
	count: number,
	crash?: { point: CrashPoint; at: number },
): BackfillPorts {
	let casCount = 0,
		stripeCount = 0,
		journalCount = 0
	return {
		loadFacts: async () => writeFacts(count, world.payerName, world.shape),
		loadCustomerFacts: async (id) => {
			const idx = Number(id.slice('mcu-'.length))
			const holder = world.stale.has(id)
				? world.shape[idx]!.holder
				: world.userIds.get(id)
			if (!holder) return null
			const base = writeFacts(count, world.payerName, world.shape).find(
				(f) => f.customerId === id,
			)!
			return {
				...base,
				holderUserId: holder,
				stripe: {
					...quiet,
					chargeCreated: [
						...quiet.chargeCreated,
						...(world.usage.get(id) ?? []),
					],
				},
			}
		},
		inFlightTransferUserIds: async () => new Set(world.openUsers),
		compareAndSet: async ({ customerId, holderUserId, payerUserId }) => {
			world.calls.push(`cas:${customerId}`)
			let affected = 0
			// The real port checks open transfers in the same transaction.
			if (
				world.userIds.get(customerId) === holderUserId &&
				(world.openUsers.has(holderUserId) || world.openUsers.has(payerUserId))
			)
				return 'deferred' as const
			if (world.userIds.get(customerId) === holderUserId) {
				world.userIds.set(customerId, payerUserId)
				affected = 1
			}
			if (affected && crash?.point === 'after-cas' && casCount++ === crash.at) {
				world.crashed = true
				throw new Crash()
			}
			return affected
		},
		readCustomerUserId: async (id) => world.userIds.get(id) ?? null,
		updateStripeCustomer: async ({
			stripeCustomerId,
			email,
			name,
			idempotencyKey,
		}) => {
			world.calls.push(`stripe:${stripeCustomerId}`)
			const row = world.stripe.get(stripeCustomerId)!
			// Stripe dedupes a replayed idempotency key and applies nothing.
			if (idempotencyKey && world.keys.has(idempotencyKey)) {
				/* replay */
			} else {
				if (idempotencyKey) world.keys.set(idempotencyKey, true)
				else world.unkeyedWrites += 1
				row.email = email
				// An empty name clears the field, as Stripe does.
				if (name !== null && name !== undefined)
					row.name = name === '' ? null : name
				row.applied += 1
			}
			if (crash?.point === 'after-stripe' && stripeCount++ === crash.at) {
				world.crashed = true
				throw new Crash()
			}
		},
		readStripeCustomer: async (id) => world.stripe.get(id) ?? null,
		readJournal: async () => [...world.journal],
		appendJournal: async (entry) => {
			world.journal.push(entry)
			if (
				entry.t === 'stripe' &&
				crash?.point === 'after-journal' &&
				journalCount++ === crash.at
			) {
				world.crashed = true
				throw new Crash()
			}
		},
		stopRequested: async () => world.stop,
		throttle: async () => {},
	}
}

async function planHashFor(
	mod: Backfill,
	count: number,
	payerName: string | null = userA.name,
	shape?: Shape[],
) {
	return mod.planHashOf(mod.planAll(writeFacts(count, payerName, shape)))
}
const approve = { approval: 'operator approval' }

function snapshot(world: World) {
	return JSON.stringify({
		users: [...world.userIds].sort(),
		stripe: [...world.stripe].sort(),
		stripeLines: world.journal.filter((e) => e.t === 'stripe').length,
	})
}

/** Every crash point, then a clean resume, must end where a clean run ends. */
async function crashModel(mod: Backfill): Promise<string[]> {
	const violations: string[] = []
	const count = 3
	const planHash = await planHashFor(mod, count)
	const clean = newWorld(count)
	await mod.runWrite(
		{ ...approve, planHash, batch: 25 },
		portsFor(clean, count),
	)
	const expected = snapshot(clean)
	const points: CrashPoint[] = ['after-cas', 'after-stripe', 'after-journal']
	const runs: { point: CrashPoint; at: number }[][] = []
	for (const point of points)
		for (let at = 0; at < count; at += 1) runs.push([{ point, at }])
	// Double crashes: a crash, then another crash on the resume, then clean.
	for (const a of points)
		for (const b of points)
			runs.push([
				{ point: a, at: 0 },
				{ point: b, at: 0 },
			])
	for (const crashes of runs) {
		const world = newWorld(count)
		for (const crash of crashes) {
			try {
				await mod.runWrite(
					{ ...approve, planHash, batch: 25 },
					portsFor(world, count, crash),
				)
			} catch (error) {
				// The write path wraps a Stripe-side throw in its own literal error.
				if (!(error instanceof Crash) && !world.crashed) throw error
				world.crashed = false
			}
		}
		await mod.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		const label = JSON.stringify(crashes)
		if (snapshot(world) !== expected)
			violations.push(`end state differs: ${label}`)
		for (const [id, row] of world.stripe)
			if (row.applied !== 1)
				violations.push(`${id} written ${row.applied}x: ${label}`)
		if (world.unkeyedWrites > 0)
			violations.push(`unkeyed stripe write: ${label}`)
	}
	return violations
}

/** Fresh facts catch a changed holder; the CAS catches a race after them. */
async function conflictModel(mod: Backfill): Promise<string[]> {
	const violations: string[] = []
	const count = 3
	const planHash = await planHashFor(mod, count)
	const world = newWorld(count)
	// mcu-0: a third party moved it before the write (drift).
	world.userIds.set('mcu-0', userC.id)
	// mcu-1: it moves after the fresh read, before the CAS (race).
	world.userIds.set('mcu-1', userC.id)
	world.stale.add('mcu-1')
	const result = await mod.runWrite(
		{ ...approve, planHash, batch: 25 },
		portsFor(world, count),
	)
	if (world.userIds.get('mcu-0') !== userC.id)
		violations.push('overwrote a drifted row')
	if (world.userIds.get('mcu-1') !== userC.id)
		violations.push('CAS overwrote a changed row')
	if (world.calls.includes('stripe:cus_0'))
		violations.push('stripe called on drift')
	if (world.calls.includes('stripe:cus_1'))
		violations.push('stripe called on a CAS conflict')
	if (result.drift !== 1) violations.push('drift not counted')
	if (result.conflicts !== 1) violations.push('conflict not counted')
	if (world.userIds.get('mcu-2') !== userA.id)
		violations.push('clean row not moved')
	return violations
}

/** A payer with no name must not leave the holder's name on their customer. */
async function nullNameModel(mod: Backfill): Promise<string[]> {
	const count = 2
	const world = newWorld(count)
	world.payerName = null
	const planHash = await planHashFor(mod, count, null)
	await mod.runWrite(
		{ ...approve, planHash, batch: 25 },
		portsFor(world, count),
	)
	return [...world.stripe.values()].some((row) => row.name !== null)
		? ['holder name left on the payer customer']
		: []
}

/** Usage that appears after batch one must stop that row, not the others. */
async function driftModel(mod: Backfill): Promise<string[]> {
	const violations: string[] = []
	const count = 3
	const planHash = await planHashFor(mod, count)
	const world = newWorld(count)
	const first = await mod.runWrite(
		{ ...approve, planHash, batch: 1 },
		portsFor(world, count),
	)
	if (first.status !== 'batch-complete') violations.push('batch did not stop')
	world.usage.set('mcu-1', [sec(60)])
	const rest = await mod.runWrite(
		{ ...approve, planHash, batch: 25 },
		portsFor(world, count),
	)
	if (world.userIds.get('mcu-1') !== userB.id)
		violations.push('stale resume wrote a row with new holder usage')
	if (world.calls.includes('stripe:cus_1'))
		violations.push('stale resume called stripe for a drifted row')
	if (rest.drift !== 1) violations.push('stale resume drift not counted')
	if (world.userIds.get('mcu-2') !== userA.id)
		violations.push('resume skipped a clean row')
	const entry = world.journal.find((e) => e.t === 'drift')
	if (!entry || entry.t !== 'drift' || !entry.reason.startsWith('carve-out'))
		violations.push('drift not journaled with its reason')
	const readback = await mod.runReadback({ planHash }, portsFor(world, count))
	if (readback.drift !== 1) violations.push('readback drift not counted')
	// A rerun never retries a drifted row.
	await mod.runWrite(
		{ ...approve, planHash, batch: 25 },
		portsFor(world, count),
	)
	if (world.userIds.get('mcu-1') !== userB.id)
		violations.push('rerun retried a drifted row')
	return violations
}

async function planModel(mod: Backfill): Promise<string[]> {
	const violations: string[] = []
	for (const s of scenarios) {
		const got = mod.planPayerCustomerBackfill(s.facts)
		if (got.decision !== s.decision || got.reason !== s.reason)
			violations.push(`${s.name}: got ${got.decision}/${got.reason}`)
		if (s.payer && got.payerUserId !== s.payer)
			violations.push(`${s.name}: payer ${got.payerUserId}`)
	}
	const next = rng(7)
	for (let i = 0; i < 3000; i += 1) {
		const f = randomFacts(next)
		const got = mod.planPayerCustomerBackfill(f)
		if (got.decision === 'move' && oracleUsed(f))
			violations.push(`move onto a customer the holder used (case ${i})`)
	}
	return violations
}

/** A row tied to an open transfer is skipped; every other row moves. */
async function deferModel(mod: Backfill): Promise<string[]> {
	const violations: string[] = []
	const plain: Shape = { holder: userB.id, payer: userA.id }
	const holderC: Shape = { holder: userC.id, payer: userA.id }
	const payerC: Shape = { holder: userB.id, payer: userC.id }
	const run = async (
		shape: Shape[],
		setup: (world: World, ports: BackfillPorts) => void,
		batch = 25,
	) => {
		const world = newWorld(shape.length, shape)
		const ports = portsFor(world, shape.length)
		setup(world, ports)
		const planHash = await planHashFor(mod, shape.length, userA.name, shape)
		const result = await mod.runWrite({ ...approve, planHash, batch }, ports)
		const done = world.journal.flatMap((e) => (e.t === 'header' ? [] : [e.t]))
		return { world, result, journalKinds: done }
	}
	const stripeFor = (world: World, i: number) =>
		world.calls.includes(`stripe:cus_${i}`)
	const holderCase = await run([plain, holderC, plain], (w) =>
		w.openUsers.add(userC.id),
	)
	if (holderCase.world.userIds.get('mcu-1') !== userC.id)
		violations.push('holder in an open transfer was written')
	if (holderCase.journalKinds.length !== 2)
		violations.push('deferred row journaled as done')
	if (holderCase.result.deferred !== 1) violations.push('deferral not counted')
	const payerCase = await run([plain, payerC, plain], (w) =>
		w.openUsers.add(userC.id),
	)
	if (payerCase.world.userIds.get('mcu-1') !== userB.id)
		violations.push('payer in an open transfer was written')
	if (payerCase.result.deferredBy.beforeRow !== 1)
		violations.push('payer in an open transfer not skipped before the row')
	const reread = await run([plain, plain, holderC, plain], (_w, ports) => {
		let reads = 0
		ports.inFlightTransferUserIds = async () =>
			reads++ >= 2 ? new Set([userC.id]) : new Set()
	})
	if (reread.world.userIds.get('mcu-2') !== userC.id)
		violations.push('open set not re-read per row')
	const race = await run([plain, holderC, plain], (w, ports) => {
		const load = ports.loadCustomerFacts
		ports.loadCustomerFacts = async (id) => {
			if (id === 'mcu-1') w.openUsers.add(userC.id)
			return load(id)
		}
	})
	if (race.world.userIds.get('mcu-1') !== userC.id)
		violations.push('transfer opened before the write was still written')
	if (stripeFor(race.world, 1)) violations.push('deferral reached stripe')
	if (race.journalKinds.includes('conflict'))
		violations.push('deferral journaled as conflict')
	if (race.result.deferred !== 1)
		violations.push('deferral at write not counted')
	const unrelated = await run([plain, plain, plain], (w) =>
		w.openUsers.add('user-unrelated'),
	)
	if (unrelated.result.moved !== 3)
		violations.push('unrelated open transfer blocked a row')
	const batched = await run(
		[holderC, plain, plain, plain],
		(w) => w.openUsers.add(userC.id),
		2,
	)
	if (batched.result.moved !== 2)
		violations.push('deferred row counted toward the batch')
	return violations
}

const runtimeSql = (rt: Runtime) => async () => {
	const queries: { sql: string; params: unknown[] }[] = []
	const db = drizzle(
		async (query, params) => {
			queries.push({ sql: query, params })
			return { rows: [{ insertId: 0, affectedRows: 1 }] }
		},
		{ schema },
	)
	const withTx = Object.assign(Object.create(db), {
		transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	})
	await rt.createDrizzleDbPorts(withTx as never).compareAndSet({
		customerId: 'mcu-1',
		holderUserId: 'user-b',
		payerUserId: 'user-a',
	})
	const update = queries.find((q) => q.sql.toLowerCase().startsWith('update'))
	const violations: string[] = []
	if (!update) return ['no update issued']
	if (
		!/where \(`\w+`\.`id` = \? and `\w+`\.`userId` = \? and not exists \(/i.test(
			update.sql,
		)
	)
		violations.push(`update is not compare-and-set: ${update.sql}`)
	if (!/transferState/i.test(update.sql))
		violations.push(`update has no open-transfer check: ${update.sql}`)
	return violations
}

async function invariantViolations(mod: Backfill, rt: Runtime) {
	return [
		...(await planModel(mod)),
		...(await conflictModel(mod)),
		...(await driftModel(mod)),
		...(await nullNameModel(mod)),
		...(await crashModel(mod)),
		...(await deferModel(mod)),
		...(await runtimeSql(rt)()),
	]
}

// ------------------------------------------------------------------ tests --

describe('planPayerCustomerBackfill', () => {
	for (const s of scenarios)
		it(s.name, () => {
			const got = backfill.planPayerCustomerBackfill(s.facts)
			expect(got.decision).toBe(s.decision)
			expect(got.reason).toBe(s.reason)
			if (s.payer) expect(got.payerUserId).toBe(s.payer)
			if (s.decision === 'move') {
				expect(got.payerEmail).toBe(userA.email)
				expect(got.payerName).toBe(s.facts.users[userA.id]!.name)
			}
		})

	it('covers every reason', () => {
		const seen = new Set(scenarios.map((s) => s.reason).filter(Boolean))
		for (const reason of [
			...backfill.SKIP_REASONS,
			...backfill.CARVE_OUT_REASONS,
		])
			expect(seen.has(reason), reason).toBe(true)
	})

	it('property: a move never targets a customer the holder used after the transfer', () => {
		const next = rng(11)
		let moves = 0
		for (let i = 0; i < 5000; i += 1) {
			const f = randomFacts(next)
			const got = backfill.planPayerCustomerBackfill(f)
			if (got.decision === 'move') {
				moves += 1
				expect(oracleUsed(f)).toBe(false)
				expect(got.payerUserId).not.toBe(f.holderUserId)
			}
		}
		expect(moves).toBeGreaterThan(50)
	})

	it('the plan hash is order independent and covers the Stripe targets', () => {
		const a = backfill.planAll([
			facts({ customerId: 'x' }),
			facts({ customerId: 'y' }),
		])
		expect(backfill.planHashOf(a)).toBe(backfill.planHashOf([...a].reverse()))
		const changed = a.map((p) => ({ ...p, payerEmail: 'other@example.test' }))
		expect(backfill.planHashOf(changed)).not.toBe(backfill.planHashOf(a))
	})

	it('counts carry no ids or emails', () => {
		const counts = backfill.countPlan(backfill.planAll([facts()]))
		const text = JSON.stringify(counts)
		expect(text).not.toContain('mcu-1')
		expect(text).not.toContain('example.test')
		expect(counts.move).toBe(1)
		expect(counts.planHash).toMatch(/^[a-f0-9]{64}$/)
	})
})

describe('runWrite', () => {
	const count = 3

	it('writes in CAS, Stripe, journal order with the keyed update', async () => {
		const world = newWorld(count)
		const planHash = await planHashFor(backfill, count)
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		expect(result).toMatchObject({
			status: 'complete',
			moved: 3,
			conflicts: 0,
		})
		expect(world.calls.slice(0, 2)).toEqual(['cas:mcu-0', 'stripe:cus_0'])
		expect(world.keys.has(`payer-backfill:mcu-0:${planHash}`)).toBe(true)
		expect(world.stripe.get('cus_0')).toMatchObject({
			email: userA.email,
			name: userA.name,
		})
	})

	it('refuses a plan hash that no longer matches', async () => {
		const world = newWorld(count)
		await expect(
			backfill.runWrite(
				{ ...approve, planHash: 'a'.repeat(64), batch: 25 },
				portsFor(world, count),
			),
		).rejects.toThrow(
			/^PlanHashMismatch: you .*, and it failed because .*Accepted: .*Fix: .*Debug: /,
		)
		expect(world.calls).toEqual([])
	})

	it('refuses an empty approval', async () => {
		await expect(
			backfill.runWrite(
				{ approval: ' ', planHash: 'a'.repeat(64), batch: 1 },
				portsFor(newWorld(1), 1),
			),
		).rejects.toThrow(/^ApprovalRequired:/)
	})

	const rowsWith = (...pairs: Shape[]) => pairs
	const plain: Shape = { holder: userB.id, payer: userA.id }
	const holderC: Shape = { holder: userC.id, payer: userA.id }
	const payerC: Shape = { holder: userB.id, payer: userC.id }
	const movedIds = (world: World) =>
		[...world.userIds.entries()]
			.filter(([id, user]) => user !== world.shape[Number(id.slice(4))]!.holder)
			.map(([id]) => id)
	const journaled = (world: World) =>
		world.journal.flatMap((e) => (e.t === 'stripe' ? [e.customerId] : []))

	it('skips a row whose holder is in an open transfer and moves the rest', async () => {
		const shape = rowsWith(plain, holderC, plain)
		const world = newWorld(3, shape)
		world.openUsers = new Set([userC.id])
		const planHash = await planHashFor(backfill, 3, userA.name, shape)
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, 3),
		)
		expect(result).toMatchObject({
			status: 'complete-with-deferrals',
			moved: 2,
			deferred: 1,
			deferredBy: { beforeRow: 1, atWrite: 0 },
		})
		expect(movedIds(world)).toEqual(['mcu-0', 'mcu-2'])
		expect(journaled(world)).toEqual(['mcu-0', 'mcu-2'])
		expect(world.calls).not.toContain('stripe:cus_1')
		expect(JSON.stringify(result)).not.toContain('mcu-')
	})

	it('skips a row whose payer is in an open transfer', async () => {
		const shape = rowsWith(plain, payerC, plain)
		const world = newWorld(3, shape)
		world.openUsers = new Set([userC.id])
		const planHash = await planHashFor(backfill, 3, userA.name, shape)
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, 3),
		)
		expect(result).toMatchObject({ moved: 2, deferred: 1 })
		expect(movedIds(world)).toEqual(['mcu-0', 'mcu-2'])
		expect(journaled(world)).toEqual(['mcu-0', 'mcu-2'])
	})

	it('re-reads the open set before every row', async () => {
		const shape = rowsWith(plain, plain, holderC, plain)
		const world = newWorld(4, shape)
		const planHash = await planHashFor(backfill, 4, userA.name, shape)
		const ports = portsFor(world, 4)
		let reads = 0
		ports.inFlightTransferUserIds = async () =>
			reads++ >= 2 ? new Set([userC.id]) : new Set()
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			ports,
		)
		expect(result).toMatchObject({ moved: 3, deferred: 1 })
		expect(movedIds(world)).toEqual(['mcu-0', 'mcu-1', 'mcu-3'])
		expect(journaled(world)).not.toContain('mcu-2')
	})

	it('a transfer opened after the re-read still stops the write, and nothing reaches Stripe', async () => {
		const shape = rowsWith(plain, holderC, plain)
		const world = newWorld(3, shape)
		const planHash = await planHashFor(backfill, 3, userA.name, shape)
		const ports = portsFor(world, 3)
		const load = ports.loadCustomerFacts
		ports.loadCustomerFacts = async (id) => {
			if (id === 'mcu-1') world.openUsers.add(userC.id)
			return load(id)
		}
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			ports,
		)
		// The open set keeps user C only, so the plain third row still moves.
		expect(result).toMatchObject({
			status: 'complete-with-deferrals',
			moved: 2,
			deferred: 1,
			deferredBy: { beforeRow: 0, atWrite: 1 },
		})
		expect(world.userIds.get('mcu-1')).toBe(userC.id)
		expect(world.calls).not.toContain('stripe:cus_1')
		expect(journaled(world)).toEqual(['mcu-0', 'mcu-2'])
	})

	it('a later run moves a deferred row once its users are clear', async () => {
		const shape = rowsWith(plain, holderC, plain)
		const world = newWorld(3, shape)
		world.openUsers = new Set([userC.id])
		const planHash = await planHashFor(backfill, 3, userA.name, shape)
		await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, 3),
		)
		world.openUsers = new Set()
		const second = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, 3),
		)
		expect(second).toMatchObject({ status: 'complete', moved: 1, deferred: 0 })
		expect(movedIds(world)).toEqual(['mcu-0', 'mcu-1', 'mcu-2'])
		for (const row of world.stripe.values()) expect(row.applied).toBe(1)
	})

	it('does not count a deferred row toward --batch', async () => {
		const shape = rowsWith(holderC, plain, plain, plain)
		const world = newWorld(4, shape)
		world.openUsers = new Set([userC.id])
		const planHash = await planHashFor(backfill, 4, userA.name, shape)
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 2 },
			portsFor(world, 4),
		)
		expect(result.status).toBe('batch-complete')
		expect(result.moved).toBe(2)
		expect(result.deferred).toBe(1)
		expect(movedIds(world)).toEqual(['mcu-1', 'mcu-2'])
	})

	it('an unrelated open transfer blocks nothing', async () => {
		const world = newWorld(count)
		world.openUsers = new Set(['user-unrelated'])
		const planHash = await planHashFor(backfill, count)
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		expect(result).toMatchObject({ status: 'complete', moved: 3, deferred: 0 })
	})

	it('batches, and a rerun finishes the rest', async () => {
		const world = newWorld(count)
		const planHash = await planHashFor(backfill, count)
		const first = await backfill.runWrite(
			{ ...approve, planHash, batch: 2 },
			portsFor(world, count),
		)
		expect(first).toMatchObject({
			status: 'batch-complete',
			moved: 2,
			remaining: 1,
		})
		const second = await backfill.runWrite(
			{ ...approve, planHash, batch: 2 },
			portsFor(world, count),
		)
		expect(second).toMatchObject({ status: 'complete', moved: 1 })
	})

	it('honours the stop file between rows', async () => {
		const world = newWorld(count)
		const planHash = await planHashFor(backfill, count)
		const ports = portsFor(world, count)
		const stripe = ports.updateStripeCustomer
		ports.updateStripeCustomer = async (input) => {
			await stripe(input)
			world.stop = true
		}
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			ports,
		)
		expect(result).toMatchObject({ status: 'stopped', moved: 1, remaining: 2 })
		world.stop = false
		await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		expect([...world.userIds.values()]).toEqual([userA.id, userA.id, userA.id])
	})

	it('a Stripe failure stops the run with a literal prompt and resumes safely', async () => {
		const world = newWorld(count)
		const planHash = await planHashFor(backfill, count)
		const ports = portsFor(world, count)
		ports.updateStripeCustomer = async () => {
			throw new Error('secret detail from stripe')
		}
		const error = await backfill
			.runWrite({ ...approve, planHash, batch: 25 }, ports)
			.catch((e: Error) => e)
		expect((error as Error).message).toMatch(
			/^StripeUpdateFailed: you .*, and it failed because .*Accepted: .*Fix: .*Debug: /,
		)
		expect((error as Error).message).not.toContain('secret detail')
		await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		for (const row of world.stripe.values()) expect(row.applied).toBe(1)
	})

	it('a journal for another plan is refused', async () => {
		const world = newWorld(count)
		const planHash = await planHashFor(backfill, count)
		await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		await expect(
			backfill.runWrite(
				{ ...approve, planHash: 'b'.repeat(64), batch: 25 },
				portsFor(world, count),
			),
		).rejects.toThrow(/^JournalPlanMismatch:/)
	})

	it('readback counts rows on the payer, drift and Stripe mismatches', async () => {
		const world = newWorld(count)
		world.userIds.set('mcu-0', userC.id)
		const planHash = await planHashFor(backfill, count)
		await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			portsFor(world, count),
		)
		world.stripe.get('cus_2')!.email = 'drift@example.test'
		expect(
			await backfill.runReadback({ planHash }, portsFor(world, count)),
		).toEqual({
			planned: 3,
			onPayer: 2,
			conflicts: 0,
			drift: 1,
			stripeMismatch: 1,
			notYetWritten: 0,
		})
	})
})

describe('crash model', () => {
	it('every crash point, singly and doubled, resumes to the clean end state', async () => {
		expect(await crashModel(backfill)).toEqual([])
	})
})

describe('compare-and-set SQL', () => {
	it('guards on id and the holder it planned from', async () => {
		expect(await runtimeSql(runtime)()).toEqual([])
	})
})

describe('files and arguments', () => {
	it('journals and plan files are 0600 and survive a torn last line', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'payer-backfill-'))
		const path = join(dir, 'journal.jsonl')
		const journal = backfill.fileJournal(path)
		await journal.append({ t: 'stripe', customerId: 'mcu-1' })
		expect((await stat(path)).mode & 0o777).toBe(0o600)
		await writeFile(path, (await readFile(path, 'utf8')) + '{"t":"stri', {
			mode: 0o600,
		})
		expect(await journal.read()).toEqual([{ t: 'stripe', customerId: 'mcu-1' }])
		const plan = join(dir, 'plan.json')
		await backfill.writePrivateFile(plan, '[]')
		expect((await stat(plan)).mode & 0o777).toBe(0o600)
	})

	it('parses the three modes and rejects bad flags with a literal prompt', () => {
		const hash = 'c'.repeat(64)
		expect(backfill.parseArgs(['--plan-out', '/p'])).toEqual({
			mode: 'dry-run',
			planOut: '/p',
			rate: 10,
		})
		expect(
			backfill.parseArgs([
				'--write',
				'--plan-hash',
				hash,
				'--approval',
				'ok',
				'--journal',
				'/j',
			]),
		).toMatchObject({ mode: 'write', batch: 25, rate: 10 })
		expect(
			backfill.parseArgs([
				'--readback',
				'--plan-hash',
				hash,
				'--journal',
				'/j',
			]),
		).toMatchObject({
			mode: 'readback',
		})
		for (const argv of [
			[],
			['--write'],
			['--plan-hash', hash, '--plan-out', '/p'],
			['--plan-out', '/p', '--bogus', 'x'],
			['--plan-out', '/p', '--journal', '/j'],
			['--readback', '--plan-hash', hash, '--journal', '/j', '--batch', '5'],
			[
				'--write',
				'--plan-hash',
				hash,
				'--approval',
				'ok',
				'--journal',
				'/j',
				'--plan-out',
				'/p',
			],
		])
			expect(() => backfill.parseArgs(argv)).toThrow(
				/^ArgumentsInvalid: you .* Accepted: .* Fix: .* Debug: /,
			)
	})

	it('operator files are create-only and refused inside a git worktree', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'payer-backfill-'))
		const plan = join(dir, 'plan.json')
		await backfill.writePrivateFile(plan, '[]')
		await expect(backfill.writePrivateFile(plan, '[1]')).rejects.toThrow(
			/^FileExists:/,
		)
		expect(await readFile(plan, 'utf8')).toBe('[]')
		expect(() => backfill.assertOutsideWorktree(plan)).not.toThrow()
		await mkdir(join(dir, '.git'))
		expect(() => backfill.assertOutsideWorktree(join(dir, 'sub', 'j'))).toThrow(
			/^FileInsideWorktree:/,
		)
	})

	it('a jj workspace counts as a worktree too', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'payer-backfill-'))
		await mkdir(join(dir, '.jj'))
		expect(() => backfill.assertOutsideWorktree(join(dir, 'j'))).toThrow(
			/^FileInsideWorktree:/,
		)
	})

	it('an append after a torn last line starts on a new line', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'payer-backfill-'))
		const path = join(dir, 'journal.jsonl')
		const journal = backfill.fileJournal(path)
		await journal.append({ t: 'stripe', customerId: 'mcu-1' })
		await writeFile(path, (await readFile(path, 'utf8')) + '{"t":"stri', {
			mode: 0o600,
		})
		await journal.append({ t: 'stripe', customerId: 'mcu-2' })
		expect(await journal.read()).toEqual([
			{ t: 'stripe', customerId: 'mcu-1' },
			{ t: 'stripe', customerId: 'mcu-2' },
		])
	})

	it('a resume onto a Stripe customer deleted meanwhile is drift, not an error', async () => {
		const world = newWorld(2)
		world.userIds.set('mcu-0', userA.id)
		const planHash = await planHashFor(backfill, 2)
		const ports = portsFor(world, 2)
		const real = ports.loadCustomerFacts
		ports.loadCustomerFacts = async (id) => {
			const f = await real(id)
			return f && id === 'mcu-0'
				? { ...f, stripe: { ...f.stripe, deleted: true } }
				: f
		}
		const result = await backfill.runWrite(
			{ ...approve, planHash, batch: 25 },
			ports,
		)
		expect(result.drift).toBe(1)
		expect(world.calls).not.toContain('stripe:cus_0')
		expect(world.journal).toContainEqual({
			t: 'drift',
			customerId: 'mcu-0',
			reason: 'resume:stripe-customer-deleted',
		})
		expect(world.userIds.get('mcu-1')).toBe(userA.id)
	})

	it('the journal header records the approval, time and plan hash', async () => {
		const world = newWorld(1)
		const planHash = await planHashFor(backfill, 1)
		await backfill.runWrite(
			{
				approval: ' approved by operator ',
				planHash,
				batch: 5,
				now: () => '2026-10-16T05:00:00.000Z',
			},
			portsFor(world, 1),
		)
		expect(world.journal[0]).toMatchObject({
			t: 'header',
			planHash,
			approval: 'approved by operator',
			approvedAt: '2026-10-16T05:00:00.000Z',
		})
	})

	it('the dry run counts payers with other customers and Stripe drift on moved rows', () => {
		const plan = backfill.planAll([
			facts({ customerId: 'a', payerOtherCustomers: 1 }),
			facts({ customerId: 'b' }),
			facts({
				customerId: 'c',
				holderUserId: userA.id,
				stripe: { ...quiet, email: 'b@example.test' },
				purchases: [
					{
						purchaseId: 'p',
						chargeUserId: userA.id,
						openDispute: false,
						transfers: [transfer('t', userA.id, T0)],
					},
				],
			}),
			facts({
				customerId: 'd',
				holderUserId: userA.id,
				stripe: { ...quiet, email: 'a@example.test', name: 'Payer A' },
				purchases: [
					{
						purchaseId: 'p',
						chargeUserId: userA.id,
						openDispute: false,
						transfers: [transfer('t', userA.id, T0)],
					},
				],
			}),
		])
		const counts = backfill.countPlan(plan)
		expect(counts.payerHasOtherCustomer).toBe(1)
		expect(counts.dbOnPayerStripeDiffers).toBe(1)
	})

	it('rate limiter spaces calls', async () => {
		let t = 0
		const sleeps: number[] = []
		const limit = runtime.createRateLimiter(
			10,
			() => t,
			async (ms) => {
				sleeps.push(ms)
				t += ms
			},
		)
		await limit()
		await limit()
		await limit()
		expect(sleeps).toEqual([100, 100])
	})
})

// ------------------------------------------------------- planted mutations --

const scriptsDir = join(__dirname, '../../scripts')

let plantCount = 0
/** Whitespace-insensitive anchor, so formatting never breaks a plant. */
function anchorPattern(find: string) {
	const tokens = find
		.trim()
		.split(/\s+/)
		.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
	return new RegExp(tokens.join('\\s*'), 'g')
}

/**
 * Plant a defect in a copy of the real source, load it, and run the same
 * invariant suite. Every copy gets its own unique path and module id.
 */
async function plant(
	file: 'payer-customer-backfill' | 'payer-customer-backfill-runtime',
	find: string,
	replace: string,
) {
	const n = (plantCount += 1)
	const read = (name: string) =>
		readFile(join(scriptsDir, `${name}.ts`), 'utf8')
	const source = await read(file)
	const pattern = anchorPattern(find)
	expect(
		(source.match(pattern) ?? []).length,
		`anchor: ${find.slice(0, 40)}`,
	).toBe(1)
	const mutated = source.replace(pattern, () => replace)
	const written: string[] = []
	const write = async (name: string, text: string) => {
		const path = join(scriptsDir, `${name}.mutant-${n}.ts`)
		written.push(path)
		await writeFile(path, text)
		return path
	}
	try {
		const mainName = 'payer-customer-backfill'
		const main = file === mainName ? mutated : await read(mainName)
		const run =
			file === mainName
				? await read('payer-customer-backfill-runtime')
				: mutated
		const mainPath = await write(mainName, main)
		const runPath = await write(
			'payer-customer-backfill-runtime',
			run.replace(
				"'./payer-customer-backfill'",
				`'./payer-customer-backfill.mutant-${n}'`,
			),
		)
		const mod = (await import(/* @vite-ignore */ mainPath)) as Backfill
		const rt = (await import(/* @vite-ignore */ runPath)) as Runtime
		return await invariantViolations(mod, rt)
	} finally {
		await Promise.all(written.map((path) => unlink(path).catch(() => {})))
	}
}

/** Each mutant must trip the specific check that guards it. */
const mutants: {
	name: string
	file: 'payer-customer-backfill' | 'payer-customer-backfill-runtime'
	find: string
	replace: string
	caughtBy: RegExp
}[] = [
	{
		name: 'carve-out check dropped',
		file: 'payer-customer-backfill',
		find: "if (facts.stripe.chargeCreated.some((at) => at >= completedAt)) return carve('holder-charge-after-transfer')",
		replace: '',
		caughtBy: /charge after the transfer|move onto a customer the holder used/,
	},
	{
		name: 'latest transfer instead of earliest',
		file: 'payer-customer-backfill',
		find: 'transfers: purchase.transfers, }) if (!payer)',
		replace:
			"transfers: purchase.transfers.filter((t) => t.state !== 'COMPLETED').concat(purchase.transfers.filter((t) => t.state === 'COMPLETED').sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime()).slice(0, 1)), })\n if (!payer)",
		caughtBy: /chain A to B to C pays A/,
	},
	{
		name: 'compare-and-set dropped (where id only)',
		file: 'payer-customer-backfill-runtime',
		find: '.where( and( eq(schema.merchantCustomer.id, input.customerId), eq(schema.merchantCustomer.userId, input.holderUserId), notExists(',
		replace:
			'.where( and( eq(schema.merchantCustomer.id, input.customerId), notExists(',
		caughtBy: /update is not compare-and-set/,
	},
	{
		name: 'compare-and-set without the open-transfer check',
		file: 'payer-customer-backfill-runtime',
		find: 'notExists( tx .select({ one: sql`1` }) .from(schema.purchaseUserTransfer) .where(and(openTransferWhere(), touchesRow)), ),',
		replace: '',
		caughtBy: /update is not compare-and-set/,
	},
	{
		name: 'a write-time deferral is not honored',
		file: 'payer-customer-backfill',
		find: "if (affected === 'deferred') return 'deferred'",
		replace: '',
		caughtBy: /deferral journaled as conflict|deferral at write not counted/,
	},
	{
		name: 'open transfer set read once at the start',
		file: 'payer-customer-backfill',
		find: 'const open = await ports.inFlightTransferUserIds() if (open.has(move.holderUserId)',
		replace:
			'const open = index === 0 ? ((result as any)._c = await ports.inFlightTransferUserIds()) : (result as any)._c\n if (open.has(move.holderUserId)',
		caughtBy: /open set not re-read per row/,
	},
	{
		name: 'only the holder is checked against open transfers',
		file: 'payer-customer-backfill',
		find: '|| open.has(move.payerUserId!)',
		replace: '',
		caughtBy: /payer in an open transfer not skipped before the row/,
	},
	{
		name: 'deferred rows are journaled as done',
		file: 'payer-customer-backfill',
		find: 'result.deferredBy.beforeRow += 1 continue',
		replace:
			"result.deferredBy.beforeRow += 1\n await ports.appendJournal({ t: 'drift', customerId: move.customerId, reason: 'deferred' })\n continue",
		caughtBy: /deferred row journaled as done/,
	},
	{
		name: 'an unrelated open transfer blocks the row',
		file: 'payer-customer-backfill',
		find: 'open.has(move.holderUserId) || open.has(move.payerUserId!)',
		replace: 'open.size > 0',
		caughtBy: /unrelated open transfer blocked a row/,
	},
	{
		name: 'Stripe called on a compare-and-set conflict',
		file: 'payer-customer-backfill',
		find: "return 'conflict' } outcome = 'resumed'",
		replace: "} outcome = 'resumed'",
		caughtBy: /stripe called on a CAS conflict/,
	},
	{
		name: 'a resume repeats the Stripe write without the key',
		file: 'payer-customer-backfill',
		find: 'idempotencyKey: idempotencyKey(move.customerId, planHash),',
		replace:
			"idempotencyKey: outcome === 'resumed' ? '' : idempotencyKey(move.customerId, planHash),",
		caughtBy: /unkeyed stripe write|written 2x/,
	},
	{
		name: 'no per-row drift check before the write',
		file: 'payer-customer-backfill',
		find: 'const reason = driftReason(move, fresh)',
		replace: 'const reason = null',
		caughtBy: /stale resume wrote|overwrote a drifted row/,
	},
	{
		name: 'null payer name left unset on Stripe',
		file: 'payer-customer-backfill',
		find: "name: move.payerName ?? '',",
		replace: 'name: move.payerName as string,',
		caughtBy: /holder name left on the payer customer/,
	},
	{
		name: 'same-second boundary exclusive',
		file: 'payer-customer-backfill',
		find: 'if (facts.stripe.chargeCreated.some((at) => at >= completedAt))',
		replace: 'if (facts.stripe.chargeCreated.some((at) => at > completedAt))',
		caughtBy: /same-second charge|move onto a customer the holder used/,
	},
	{
		name: 'completedAt not floored to whole seconds',
		file: 'payer-customer-backfill',
		find: 'Math.floor(Math.min(...(stamps as number[])) / 1000)',
		replace: 'Math.min(...(stamps as number[])) / 1000',
		caughtBy: /move onto a customer the holder used|charge after/,
	},
]

describe('planted mutations are caught', () => {
	it('control: the real code has no violations', async () => {
		expect(await invariantViolations(backfill, runtime)).toEqual([])
	})

	for (const mutant of mutants)
		it(mutant.name, async () => {
			const found = await plant(mutant.file, mutant.find, mutant.replace)
			expect(found.length).toBeGreaterThan(0)
			expect(found.join('\n')).toMatch(mutant.caughtBy)
		})
})
