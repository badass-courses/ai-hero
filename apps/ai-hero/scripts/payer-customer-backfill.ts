/**
 * Payer customer backfill. Dry run by default.
 *
 *   dry run   --plan-out <file>
 *   write     --write --plan-hash <hex> --approval <text> --journal <file>
 *                     [--batch <n>] [--stop-file <path>] [--rate <per-second>]
 *   readback  --readback --plan-hash <hex> --journal <file>
 *
 * Before the payer fix, a self-service transfer also rewrote
 * `MerchantCustomer.userId` to the holder and set the Stripe customer's email
 * and name to the holder's. The fix stopped that for new transfers. This
 * script puts the customer record and the Stripe customer back with the payer
 * for the old rows.
 *
 * THE WRITE IS ONE-WAY. The exact write set is `MerchantCustomer.userId` and
 * the Stripe customer's `email` and `name`. The Stripe change can only be
 * undone by hand. Nothing else is written: no charges, refunds, invoices or
 * emails from this script.
 *
 * Per row: re-read and compare-and-set the database row, then update the
 * Stripe customer with an idempotency key, then append a journal line. The
 * journal makes a crashed or stopped run resumable without a double write.
 *
 * Stdout carries counts only. The plan and journal files hold ids and emails,
 * so they are 0600.
 */
import { createHash } from 'node:crypto'
import { chmod, open, readFile, stat, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
	pickOriginTransfer,
	resolveInvoicePayer,
	type InvoiceTransferFact,
} from '../src/lib/invoice-access-rules'

// ---------------------------------------------------------------- plan ----

export type PayerUser = { id: string; email: string; name: string | null }

export type PurchaseFacts = {
	purchaseId: string
	/** `MerchantCharge.userId` for the purchase's charge. */
	chargeUserId: string | null
	transfers: InvoiceTransferFact[]
	/** Purchase is `Disputed` or carries an open dispute record. */
	openDispute: boolean
}

export type StripeCustomerFacts = {
	deleted: boolean
	email: string | null
	name: string | null
	/** Epoch seconds. */
	chargeCreated: number[]
	paymentIntentCreated: number[]
	paymentMethodCreated: number[]
	subscriptions: { created: number; status: string }[]
}

export type CustomerFacts = {
	/** `MerchantCustomer.id`. */
	customerId: string
	/** Stripe customer id (`MerchantCustomer.identifier`). */
	stripeCustomerId: string
	/** `MerchantCustomer.userId` now. */
	holderUserId: string
	purchases: PurchaseFacts[]
	users: Record<string, PayerUser | undefined>
	/** Active rows in `MerchantSubscription`/`Subscription` on the customer. */
	activeSubscriptionRows: number
	stripe: StripeCustomerFacts
}

export const SKIP_REASONS = [
	'no-completed-transfer',
	'ambiguous-payer',
	'payer-user-missing',
	'holder-user-missing',
	'stripe-customer-deleted',
	'already-on-payer',
] as const
export const CARVE_OUT_REASONS = [
	'open-dispute',
	'active-subscription',
	'holder-charge-after-transfer',
	'holder-payment-intent-after-transfer',
	'holder-payment-method-after-transfer',
	'holder-subscription-after-transfer',
] as const
export type SkipReason = (typeof SKIP_REASONS)[number]
export type CarveOutReason = (typeof CARVE_OUT_REASONS)[number]

export type PlanItem = {
	customerId: string
	stripeCustomerId: string
	holderUserId: string
	payerUserId: string | null
	decision: 'move' | 'carve-out' | 'skip'
	reason: SkipReason | CarveOutReason | null
	/** Present on moves only: what Stripe will be set to. */
	payerEmail?: string
	payerName?: string | null
}

const INACTIVE_STRIPE_SUBSCRIPTION = new Set(['canceled', 'incomplete_expired'])

const item = (
	facts: CustomerFacts,
	payerUserId: string | null,
	decision: PlanItem['decision'],
	reason: PlanItem['reason'],
): PlanItem => ({
	customerId: facts.customerId,
	stripeCustomerId: facts.stripeCustomerId,
	holderUserId: facts.holderUserId,
	payerUserId,
	decision,
	reason,
})

/**
 * Pure decision for one customer. Precedence: ambiguous and missing before
 * carve-out, carve-out before move. The payer is the source of the earliest
 * COMPLETED transfer (`pickOriginTransfer`), the same rule invoice access uses.
 */
export function planPayerCustomerBackfill(facts: CustomerFacts): PlanItem {
	const transferred = facts.purchases.filter((purchase) =>
		purchase.transfers.some((transfer) => transfer.state === 'COMPLETED'),
	)
	if (transferred.length === 0)
		return item(facts, null, 'skip', 'no-completed-transfer')

	// Every purchase on the customer must name the same payer. A completed
	// transfer with no usable timestamp has no knowable origin: ambiguous.
	const payers = new Set<string>()
	for (const purchase of facts.purchases) {
		const completed = purchase.transfers.filter((t) => t.state === 'COMPLETED')
		if (completed.length > 0 && !pickOriginTransfer(purchase.transfers))
			return item(facts, null, 'skip', 'ambiguous-payer')
		const payer = resolveInvoicePayer({
			chargeUserId: purchase.chargeUserId,
			transfers: purchase.transfers,
		})
		if (!payer) return item(facts, null, 'skip', 'ambiguous-payer')
		payers.add(payer)
	}
	if (payers.size !== 1) return item(facts, null, 'skip', 'ambiguous-payer')
	const payerUserId = [...payers][0]!

	const payerUser = facts.users[payerUserId]
	if (!payerUser?.email)
		return item(facts, payerUserId, 'skip', 'payer-user-missing')
	if (!facts.users[facts.holderUserId])
		return item(facts, payerUserId, 'skip', 'holder-user-missing')
	if (facts.stripe.deleted)
		return item(facts, payerUserId, 'skip', 'stripe-customer-deleted')
	if (facts.holderUserId === payerUserId)
		return item(facts, payerUserId, 'skip', 'already-on-payer')

	// The holder used the customer after the transfer when anything on it was
	// created after the earliest completed transfer, or it is still live.
	const completedAt = Math.min(
		...transferred.flatMap((purchase) =>
			purchase.transfers
				.filter((t) => t.state === 'COMPLETED')
				.map((t) => (t.completedAt ?? t.createdAt)!.getTime() / 1000),
		),
	)
	const carve = (reason: CarveOutReason) =>
		item(facts, payerUserId, 'carve-out', reason)
	if (facts.purchases.some((purchase) => purchase.openDispute))
		return carve('open-dispute')
	if (
		facts.activeSubscriptionRows > 0 ||
		facts.stripe.subscriptions.some(
			(sub) => !INACTIVE_STRIPE_SUBSCRIPTION.has(sub.status),
		)
	)
		return carve('active-subscription')
	if (facts.stripe.chargeCreated.some((at) => at > completedAt))
		return carve('holder-charge-after-transfer')
	if (facts.stripe.paymentIntentCreated.some((at) => at > completedAt))
		return carve('holder-payment-intent-after-transfer')
	if (facts.stripe.paymentMethodCreated.some((at) => at > completedAt))
		return carve('holder-payment-method-after-transfer')
	if (facts.stripe.subscriptions.some((sub) => sub.created > completedAt))
		return carve('holder-subscription-after-transfer')

	return {
		...item(facts, payerUserId, 'move', null),
		payerEmail: payerUser.email,
		payerName: payerUser.name,
	}
}

export function planAll(customers: CustomerFacts[]): PlanItem[] {
	return customers
		.map(planPayerCustomerBackfill)
		.sort((a, b) => a.customerId.localeCompare(b.customerId))
}

export function planHashOf(plan: PlanItem[]): string {
	const sorted = [...plan].sort((a, b) =>
		a.customerId.localeCompare(b.customerId),
	)
	return createHash('sha256')
		.update(
			JSON.stringify(
				sorted.map((p) => [
					p.customerId,
					p.stripeCustomerId,
					p.holderUserId,
					p.payerUserId,
					p.decision,
					p.reason,
					p.payerEmail ?? null,
					p.payerName ?? null,
				]),
			),
		)
		.digest('hex')
}

export type PlanCounts = {
	total: number
	move: number
	carveOut: Record<string, number>
	skip: Record<string, number>
	planHash: string
}
export function countPlan(plan: PlanItem[]): PlanCounts {
	const carveOut = Object.fromEntries(CARVE_OUT_REASONS.map((r) => [r, 0]))
	const skip = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0]))
	let move = 0
	for (const p of plan) {
		if (p.decision === 'move') move += 1
		else if (p.decision === 'carve-out') carveOut[p.reason!]! += 1
		else skip[p.reason!]! += 1
	}
	return {
		total: plan.length,
		move,
		carveOut,
		skip,
		planHash: planHashOf(plan),
	}
}

// ------------------------------------------------------------- errors ----

export class PayerBackfillError extends Error {
	constructor(
		readonly tag: string,
		message: string,
	) {
		super(message)
		this.name = tag
	}
}
/** Literal prompt: `<Tag>: you <did>, and it failed because <why>. Accepted: … Fix: … Debug: …` */
export const literal = (
	tag: string,
	did: string,
	why: string,
	accepted: string,
	fix: string,
	debug: string,
) =>
	new PayerBackfillError(
		tag,
		`${tag}: you ${did}, and it failed because ${why}. Accepted: ${accepted} Fix: ${fix} Debug: ${debug}`,
	)

const ACCEPTED =
	'a dry run with --plan-out; --write with --plan-hash, --approval and --journal; --readback with --plan-hash and --journal.'

// ----------------------------------------------------------- ports -------

export type JournalEntry =
	| { t: 'header'; planHash: string; plan: PlanItem[] }
	| { t: 'stripe'; customerId: string }
	| { t: 'conflict'; customerId: string }

export type BackfillPorts = {
	loadFacts: () => Promise<CustomerFacts[]>
	/** Transfers in INITIATED, VERIFIED or CONFIRMED right now. */
	countInFlightTransfers: () => Promise<number>
	/** One transaction: `update … set userId=payer where id=? and userId=holder`. */
	compareAndSet: (input: {
		customerId: string
		holderUserId: string
		payerUserId: string
	}) => Promise<number>
	readCustomerUserId: (customerId: string) => Promise<string | null>
	updateStripeCustomer: (input: {
		stripeCustomerId: string
		email: string
		name: string | null
		idempotencyKey: string
	}) => Promise<void>
	readStripeCustomer: (
		stripeCustomerId: string,
	) => Promise<{ email: string | null; name: string | null } | null>
	readJournal: () => Promise<JournalEntry[]>
	appendJournal: (entry: JournalEntry) => Promise<void>
	stopRequested: () => Promise<boolean>
	/** Waits so Stripe calls stay under the rate limit. */
	throttle: () => Promise<void>
}

export const idempotencyKey = (customerId: string, planHash: string) =>
	`payer-backfill:${customerId}:${planHash}`

// ------------------------------------------------------------- write -----

export type WriteResult = {
	status: 'complete' | 'batch-complete' | 'stopped'
	moved: number
	resumed: number
	conflicts: number
	remaining: number
	planHash: string
}

const HEX64 = /^[a-f0-9]{64}$/

export async function runWrite(
	args: { approval: string; planHash: string; batch: number },
	ports: BackfillPorts,
): Promise<WriteResult> {
	if (!args.approval.trim())
		throw literal(
			'ApprovalRequired',
			'asked to write without an approval',
			'--approval was empty',
			ACCEPTED,
			'pass the approval text from the desk',
			'check the command line',
		)
	if (!HEX64.test(args.planHash))
		throw literal(
			'PlanHashInvalid',
			'asked to write with a plan hash',
			'it is not a 64 character hex sha256',
			ACCEPTED,
			'copy planHash from the dry run',
			'rerun the dry run',
		)
	await assertNoTransferInFlight(ports)

	// Resume: a journal that already holds this plan carries the approved plan,
	// because moved rows no longer plan as moves.
	let journal = await ports.readJournal()
	const header = journal.find((e) => e.t === 'header')
	let plan: PlanItem[]
	if (header && header.t === 'header') {
		if (
			header.planHash !== args.planHash ||
			planHashOf(header.plan) !== args.planHash
		)
			throw literal(
				'JournalPlanMismatch',
				'resumed a write with a journal',
				'the journal belongs to a different plan',
				'the journal written for this exact plan hash.',
				'use a new journal path for a new plan, or the plan hash the journal names',
				'compare the journal header hash with --plan-hash',
			)
		plan = header.plan
	} else {
		plan = planAll(await ports.loadFacts())
		if (planHashOf(plan) !== args.planHash)
			throw literal(
				'PlanHashMismatch',
				'asked to write an approved plan',
				'the plan recomputed now hashes differently from the approved one',
				'the planHash printed by a dry run of the current data.',
				'rerun the dry run and get approval for the new hash',
				'diff the new plan file against the approved one',
			)
		await ports.appendJournal({ t: 'header', planHash: args.planHash, plan })
		journal = await ports.readJournal()
	}

	const done = new Set(
		journal.flatMap((e) =>
			e.t === 'stripe' || e.t === 'conflict' ? [e.customerId] : [],
		),
	)
	const moves = plan.filter((p) => p.decision === 'move')
	const pending = moves.filter((p) => !done.has(p.customerId))
	const result: WriteResult = {
		status: 'complete',
		moved: 0,
		resumed: 0,
		conflicts: 0,
		remaining: 0,
		planHash: args.planHash,
	}
	let worked = 0
	for (const [index, move] of pending.entries()) {
		if (await ports.stopRequested()) {
			result.status = 'stopped'
			result.remaining = pending.length - index
			return result
		}
		if (worked >= args.batch) {
			result.status = 'batch-complete'
			result.remaining = pending.length - index
			return result
		}
		await assertNoTransferInFlight(ports)
		worked += 1
		const outcome = await writeRow(move, args.planHash, ports)
		if (outcome === 'conflict') result.conflicts += 1
		else if (outcome === 'resumed') result.resumed += 1
		else result.moved += 1
	}
	return result
}

async function assertNoTransferInFlight(ports: BackfillPorts) {
	if ((await ports.countInFlightTransfers()) > 0)
		throw literal(
			'TransferInFlight',
			'asked to write while support transfers are open',
			'a purchase transfer is INITIATED, VERIFIED or CONFIRMED and could change a holder mid-run',
			'a write when no transfer is in INITIATED, VERIFIED or CONFIRMED.',
			'wait for the open transfers to finish or be canceled, then rerun the write; the journal resumes',
			'count PurchaseUserTransfer rows by transferState',
		)
}

async function writeRow(
	move: PlanItem,
	planHash: string,
	ports: BackfillPorts,
): Promise<'moved' | 'resumed' | 'conflict'> {
	const payerUserId = move.payerUserId!
	let outcome: 'moved' | 'resumed' = 'moved'
	// 1. Compare-and-set. Zero rows: either an earlier run already moved it
	// (resume), or the row changed under us (conflict, no Stripe call).
	const affected = await ports.compareAndSet({
		customerId: move.customerId,
		holderUserId: move.holderUserId,
		payerUserId,
	})
	if (affected !== 1) {
		const now = await ports.readCustomerUserId(move.customerId)
		if (now !== payerUserId) {
			await ports.appendJournal({ t: 'conflict', customerId: move.customerId })
			return 'conflict'
		}
		outcome = 'resumed'
	}
	// 2. Stripe, keyed so a replay can never double write.
	await ports.throttle()
	try {
		await ports.updateStripeCustomer({
			stripeCustomerId: move.stripeCustomerId,
			email: move.payerEmail!,
			name: move.payerName ?? null,
			idempotencyKey: idempotencyKey(move.customerId, planHash),
		})
	} catch {
		throw literal(
			'StripeUpdateFailed',
			'updated a Stripe customer from the payer backfill',
			'Stripe rejected or did not answer the customers.update call; the database row is already on the payer',
			'a rerun of the same --write command with the same journal.',
			'rerun the same command; the journal resumes and the idempotency key prevents a double write',
			'check the Stripe dashboard logs for this customer; the stop is deliberate',
		)
	}
	// 3. Journal.
	await ports.appendJournal({ t: 'stripe', customerId: move.customerId })
	return outcome
}

// ----------------------------------------------------------- readback ----

export type ReadbackResult = {
	planned: number
	onPayer: number
	conflicts: number
	stripeMismatch: number
	notYetWritten: number
}
export async function runReadback(
	args: { planHash: string },
	ports: BackfillPorts,
): Promise<ReadbackResult> {
	const journal = await ports.readJournal()
	const header = journal.find((e) => e.t === 'header')
	if (
		!header ||
		header.t !== 'header' ||
		header.planHash !== args.planHash ||
		planHashOf(header.plan) !== args.planHash
	)
		throw literal(
			'ReadbackJournalMissing',
			'asked for a readback',
			'the journal does not hold the plan for this hash',
			ACCEPTED,
			'pass the --journal used by the write and its plan hash',
			'open the journal header line',
		)
	const conflicted = new Set(
		journal.flatMap((e) => (e.t === 'conflict' ? [e.customerId] : [])),
	)
	const moves = header.plan.filter((p) => p.decision === 'move')
	const out: ReadbackResult = {
		planned: moves.length,
		onPayer: 0,
		conflicts: 0,
		stripeMismatch: 0,
		notYetWritten: 0,
	}
	for (const move of moves) {
		if (conflicted.has(move.customerId)) {
			out.conflicts += 1
			continue
		}
		const userId = await ports.readCustomerUserId(move.customerId)
		if (userId !== move.payerUserId) {
			out.notYetWritten += 1
			continue
		}
		out.onPayer += 1
		await ports.throttle()
		const stripe = await ports.readStripeCustomer(move.stripeCustomerId)
		if (
			!stripe ||
			stripe.email?.toLowerCase() !== move.payerEmail!.toLowerCase() ||
			(stripe.name ?? null) !== (move.payerName ?? null)
		)
			out.stripeMismatch += 1
	}
	return out
}

// ------------------------------------------------------------ files ------

const PRIVATE_MODE = 0o600

async function assertPrivate(path: string) {
	const info = await stat(path)
	if ((info.mode & 0o077) !== 0)
		throw literal(
			'FileNotPrivate',
			'opened an operator file',
			'it is readable by other users and holds customer ids and emails',
			'a file with mode 0600.',
			'chmod 600 the file',
			'ls -l the path',
		)
}

export async function writePrivateFile(path: string, content: string) {
	await writeFile(path, content, { mode: PRIVATE_MODE })
	await chmod(path, PRIVATE_MODE)
}

export function fileJournal(path: string) {
	return {
		async read(): Promise<JournalEntry[]> {
			let text: string
			try {
				await assertPrivate(path)
				text = await readFile(path, 'utf8')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
				throw error
			}
			const lines = text.split('\n').filter(Boolean)
			// A torn final line from a crash is dropped; resume redoes that step.
			return lines.flatMap((line, i) => {
				try {
					return [JSON.parse(line) as JournalEntry]
				} catch {
					if (i === lines.length - 1) return []
					throw literal(
						'JournalCorrupt',
						'resumed from a journal',
						'a line before the last one is not valid JSON',
						'a journal written by this script.',
						'restore the journal from a copy; do not edit it by hand',
						'inspect the journal lines',
					)
				}
			})
		},
		async append(entry: JournalEntry) {
			const handle = await open(path, 'a', PRIVATE_MODE)
			try {
				await handle.writeFile(`${JSON.stringify(entry)}\n`)
				await handle.sync()
			} finally {
				await handle.close()
			}
		},
	}
}

// ------------------------------------------------------------ args -------

export type Args =
	| { mode: 'dry-run'; planOut: string }
	| {
			mode: 'write'
			planHash: string
			approval: string
			journal: string
			batch: number
			stopFile?: string
			rate: number
	  }
	| { mode: 'readback'; planHash: string; journal: string; rate: number }

export function parseArgs(argv: readonly string[]): Args {
	const bad = (why: string) =>
		literal(
			'ArgumentsInvalid',
			'ran the payer backfill',
			why,
			ACCEPTED,
			'fix the flags',
			'run with --help is not supported; read the file header',
		)
	const flags = new Map<string, string | true>()
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i]!
		if (!flag.startsWith('--')) throw bad(`unexpected argument ${flag}`)
		if (flag === '--write' || flag === '--readback') flags.set(flag, true)
		else {
			const value = argv[i + 1]
			if (value === undefined || value.startsWith('--'))
				throw bad(`${flag} needs a value`)
			flags.set(flag, value)
			i += 1
		}
	}
	const str = (k: string) => {
		const v = flags.get(k)
		return typeof v === 'string' ? v : undefined
	}
	const write = flags.has('--write'),
		readback = flags.has('--readback')
	if (write && readback) throw bad('--write and --readback are exclusive')
	const rate = Number(str('--rate') ?? 10)
	if (!(rate > 0) || !Number.isFinite(rate))
		throw bad('--rate must be positive')
	const planHash = str('--plan-hash')
	if (write || readback) {
		if (!planHash || !HEX64.test(planHash))
			throw bad('--plan-hash must be a 64 character hex sha256')
		const journal = str('--journal')
		if (!journal) throw bad('--journal is required')
		if (readback) return { mode: 'readback', planHash, journal, rate }
		const approval = str('--approval')?.trim()
		if (!approval) throw bad('--approval is required')
		const batch = Number(str('--batch') ?? 25)
		if (!Number.isInteger(batch) || batch < 1)
			throw bad('--batch must be a positive integer')
		return {
			mode: 'write',
			planHash,
			approval,
			journal,
			batch,
			stopFile: str('--stop-file'),
			rate,
		}
	}
	const planOut = str('--plan-out')
	if (!planOut) throw bad('--plan-out is required for a dry run')
	if (planHash || str('--approval') || str('--journal'))
		throw bad(
			'--plan-hash, --approval and --journal need --write or --readback',
		)
	return { mode: 'dry-run', planOut }
}

// ------------------------------------------------------------ main -------

/** Only entrypoint. Importing this module never opens a database or Stripe. */
async function main() {
	try {
		const args = parseArgs(process.argv.slice(2))
		const { createProductionPorts } =
			await import('./payer-customer-backfill-runtime')
		const { ports, close } = await createProductionPorts(args)
		try {
			let output: unknown
			if (args.mode === 'dry-run') {
				const plan = planAll(await ports.loadFacts())
				await writePrivateFile(
					args.planOut,
					`${JSON.stringify(plan, null, 2)}\n`,
				)
				output = { mode: 'dry-run', ...countPlan(plan) }
			} else if (args.mode === 'write') {
				output = {
					mode: 'write',
					...(await runWrite(
						{
							approval: args.approval,
							planHash: args.planHash,
							batch: args.batch,
						},
						ports,
					)),
				}
			} else {
				output = {
					mode: 'readback',
					...(await runReadback({ planHash: args.planHash }, ports)),
				}
			}
			process.stdout.write(`${JSON.stringify(output)}\n`)
		} finally {
			await close()
		}
	} catch (error) {
		const text =
			error instanceof PayerBackfillError
				? error.message
				: literal(
						'InternalError',
						'ran the payer backfill',
						'an unexpected error stopped it',
						ACCEPTED,
						'rerun; a write resumes from its journal',
						'rerun with a debugger; no data is printed here by design',
					).message
		process.stderr.write(`${text}\n`)
		process.exitCode = 1
	}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	void main()
