import { createHash, timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Logger, Schema } from 'effect'
import { HttpEffect } from 'effect/http'
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from 'effect/rpc'

// The facade exposes only native types. Effect stays inside the bundle.
export interface Customer {
	readonly id: string
	readonly email: string
	readonly name: string | null
	readonly emailAliases: readonly string[]
}
export interface Purchase {
	readonly id: string
	readonly productId: string
	readonly productName: string
	/** Minor currency units. */
	readonly amount: number
	readonly currency: string
	readonly status: string
	readonly createdAt: string
	readonly seats: number
	readonly merchantChargeId: string | null
	readonly stripeChargeId: string | null
}
export interface ChargeState {
	readonly stripeChargeId: string
	readonly amount: number
	readonly currency: string
	readonly amountRefunded: number
	readonly refundCount: number
	readonly disputed: boolean
	readonly disputeStatus: string | null
	readonly presentmentAmount: number | null
	readonly presentmentCurrency: string | null
}
export interface FrontDeskHooks {
	customerByEmail(email: string): Promise<Customer | null>
	purchasesForUser(userId: string): Promise<readonly Purchase[]>
	chargeState(stripeChargeId: string): Promise<ChargeState | null>
}
export interface FrontDeskOptions {
	readonly apiKey?: string
}
export interface FrontDeskHandler {
	readonly GET: (request: Request) => Promise<Response>
	readonly POST: (request: Request) => Promise<Response>
}

const CustomerSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	emailAliases: Schema.Array(Schema.String),
})
const PurchaseSchema = Schema.Struct({
	id: Schema.String,
	productId: Schema.String,
	productName: Schema.String,
	amount: Schema.Int,
	currency: Schema.String,
	status: Schema.String,
	createdAt: Schema.String,
	seats: Schema.Int,
	merchantChargeId: Schema.NullOr(Schema.String),
	stripeChargeId: Schema.NullOr(Schema.String),
})
const ChargeSchema = Schema.Struct({
	stripeChargeId: Schema.String,
	amount: Schema.Int,
	currency: Schema.String,
	amountRefunded: Schema.Int,
	refundCount: Schema.Int,
	disputed: Schema.Boolean,
	disputeStatus: Schema.NullOr(Schema.String),
	presentmentAmount: Schema.NullOr(Schema.Int),
	presentmentCurrency: Schema.NullOr(Schema.String),
})
const Failure = Schema.Struct({
	code: Schema.Literals([
		'HOOK_FAILED',
		'INVALID_HOOK_RESULT',
		'INVALID_REQUEST',
	]),
})
const Customers = Schema.NullOr(CustomerSchema)
const Purchases = Schema.Array(PurchaseSchema)
const Charges = Schema.NullOr(ChargeSchema)
const Group = RpcGroup.make(
	Rpc.make('customerByEmail', {
		payload: { email: Schema.String },
		success: Customers,
		error: Failure,
	}),
	Rpc.make('purchasesForUser', {
		payload: { userId: Schema.String },
		success: Purchases,
		error: Failure,
	}),
	Rpc.make('chargeState', {
		payload: { stripeChargeId: Schema.String },
		success: Charges,
		error: Failure,
	}),
)

function read<S extends Schema.Constraint>(
	schema: S,
	run: () => Promise<unknown>,
) {
	return Effect.tryPromise({
		try: run,
		catch: () => ({ code: 'HOOK_FAILED' as const }),
	}).pipe(
		Effect.flatMap((value) =>
			Schema.decodeUnknownEffect(schema)(value).pipe(
				Effect.mapError(() => ({ code: 'INVALID_HOOK_RESULT' as const })),
			),
		),
	)
}

/** Native Effect RPC envelopes, JSON serialization, read-only hooks. */
export function createFrontDeskHandler(
	hooks: FrontDeskHooks,
	options: FrontDeskOptions,
): FrontDeskHandler {
	const handlers = Group.toLayer({
		customerByEmail: ({ email }) =>
			read(Customers, () => hooks.customerByEmail(email)),
		purchasesForUser: ({ userId }) =>
			read(Purchases, () => hooks.purchasesForUser(userId)),
		chargeState: ({ stripeChargeId }) =>
			read(Charges, () => hooks.chargeState(stripeChargeId)),
	})
	const app = Effect.scoped(
		RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
			Effect.flatMap((http) => http),
			Effect.provide(
				Layer.mergeAll(handlers, RpcSerialization.layerJson, Logger.layer([])),
			),
		),
	)
	const web = HttpEffect.toWebHandler(app)
	const expected = options.apiKey
		? createHash('sha256').update(options.apiKey).digest()
		: undefined
	const authorized = (request: Request) => {
		const header = request.headers.get('authorization') ?? ''
		const value = header.startsWith('Bearer ') ? header.slice(7) : ''
		// Fixed-size digests avoid a variable-length comparison or early length check.
		return (
			expected !== undefined &&
			timingSafeEqual(expected, createHash('sha256').update(value).digest())
		)
	}
	const handle = async (
		request: Request,
		method: 'GET' | 'POST',
	): Promise<Response> => {
		if (!expected)
			return Response.json({ code: 'NOT_CONFIGURED' }, { status: 503 })
		if (!authorized(request)) return new Response(null, { status: 401 })
		if (method !== 'POST')
			return new Response(null, { status: 405, headers: { Allow: 'POST' } })
		try {
			const response = await web(request)
			// RPC decoding defects can contain input values. Never send defect details.
			const messages: unknown = await response.json()
			if (!Array.isArray(messages))
				return Response.json({ code: 'INVALID_REQUEST' }, { status: 400 })
			const safe = messages.map((message) => {
				if (message._tag === 'Exit' && message.exit?._tag === 'Failure') {
					const cause = message.exit.cause
					const code = JSON.stringify(cause).includes('INVALID_HOOK_RESULT')
						? 'INVALID_HOOK_RESULT'
						: JSON.stringify(cause).includes('HOOK_FAILED')
							? 'HOOK_FAILED'
							: 'INVALID_REQUEST'
					return {
						_tag: 'Exit',
						requestId: message.requestId,
						exit: {
							_tag: 'Failure',
							cause: [{ _tag: 'Fail', error: { code } }],
						},
					}
				}
				if (message._tag === 'Defect')
					return { _tag: 'Defect', defect: { code: 'INVALID_REQUEST' } }
				return message
			})
			return Response.json(safe, {
				status: response.status,
				headers: { 'Cache-Control': 'no-store' },
			})
		} catch {
			return Response.json({ code: 'INVALID_REQUEST' }, { status: 400 })
		}
	}
	return {
		GET: (request) => handle(request, 'GET'),
		POST: (request) => handle(request, 'POST'),
	}
}
