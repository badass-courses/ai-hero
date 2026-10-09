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

// Buyer facts are a structural copy of the fields front-desk's pricing engine
// reads, and nothing else. Prices are computed in front-desk, never here.
// `_SameShape` below fails typecheck if these types and the schemas drift.
export type FactGap =
	| 'FactsUnavailable'
	| 'IdentityUnverified'
	| 'PaymentAmbiguous'
export type PricingFact<A> =
	| { readonly value: A; readonly sourceRefs: readonly string[] }
	| { readonly gap: FactGap }
export interface PricingBuyerFacts {
	readonly alumni: PricingFact<'none' | 'c3' | 'c4' | 'both'>
	/** USD cents actually paid for the one qualifying Crash Course purchase. */
	readonly credit: PricingFact<{
		readonly paid: number
		readonly source: string
	} | null>
	readonly creditUse: PricingFact<
		'available' | 'reserved-by-this-attempt' | 'spent'
	>
	readonly existingSeats: PricingFact<number>
	readonly legend: PricingFact<'no' | 'verified'>
	readonly order: PricingFact<'individual' | 'team'>
	readonly ppp: PricingFact<{
		readonly accepted: boolean
		readonly percent: number
	} | null>
}
export interface PricingRequest {
	readonly email: string
	readonly productId: string
	readonly quantity: number
	readonly orderKind: 'individual' | 'team'
}
/** Evidence about one buyer and product. front-desk prices it. */
export interface PricingFacts {
	readonly product: {
		readonly appProductId: string
		/** The single active merchant price row for the product. */
		readonly merchantPriceId: string
		/** Authoritative retail unit price, whole US cents. */
		readonly merchantUnit: number
		readonly sourceRefs: readonly string[]
	}
	readonly buyer: {
		readonly userId: string | null
		readonly sourceRefs: readonly string[]
	}
	readonly quantity: number
	readonly facts: PricingBuyerFacts
}

export interface FrontDeskHooks {
	customerByEmail(email: string): Promise<Customer | null>
	purchasesForUser(userId: string): Promise<readonly Purchase[]>
	chargeState(stripeChargeId: string): Promise<ChargeState | null>
	/** Null when the app reports no pricing facts for the product. */
	pricingFacts(request: PricingRequest): Promise<PricingFacts | null>
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
const FAILURE_CODES = [
	'HOOK_FAILED',
	'INVALID_HOOK_RESULT',
	'PRODUCT_NOT_SUPPORTED',
	'INVALID_REQUEST',
] as const
type FailureCode = (typeof FAILURE_CODES)[number]
const Failure = Schema.Struct({ code: Schema.Literals(FAILURE_CODES) })

const Cents = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Quantity = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 10_000 }),
)
const SourceRefs = Schema.Array(Schema.NonEmptyString)
const FactGapSchema = Schema.Literals([
	'FactsUnavailable',
	'IdentityUnverified',
	'PaymentAmbiguous',
])
const fact = <S extends Schema.Top>(value: S) =>
	Schema.Union([
		Schema.Struct({ value, sourceRefs: SourceRefs }),
		Schema.Struct({ gap: FactGapSchema }),
	])
const BuyerFactsSchema = Schema.Struct({
	alumni: fact(Schema.Literals(['none', 'c3', 'c4', 'both'])),
	credit: fact(
		Schema.NullOr(
			Schema.Struct({ paid: Cents, source: Schema.NonEmptyString }),
		),
	),
	creditUse: fact(
		Schema.Literals(['available', 'reserved-by-this-attempt', 'spent']),
	),
	existingSeats: fact(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	legend: fact(Schema.Literals(['no', 'verified'])),
	order: fact(Schema.Literals(['individual', 'team'])),
	ppp: fact(
		Schema.NullOr(
			Schema.Struct({
				accepted: Schema.Boolean,
				percent: Schema.Int.check(
					Schema.isBetween({ minimum: 0, maximum: 100 }),
				),
			}),
		),
	),
})
const PricingFactsSchema = Schema.Struct({
	product: Schema.Struct({
		appProductId: Schema.NonEmptyString,
		merchantPriceId: Schema.NonEmptyString,
		merchantUnit: Cents,
		sourceRefs: SourceRefs,
	}),
	buyer: Schema.Struct({
		userId: Schema.NullOr(Schema.String),
		sourceRefs: SourceRefs,
	}),
	quantity: Quantity,
	facts: BuyerFactsSchema,
})
const MaybePricingFacts = Schema.NullOr(PricingFactsSchema)

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type _SameShape = [
	Assert<Same<typeof BuyerFactsSchema.Encoded, PricingBuyerFacts>>,
	Assert<Same<typeof PricingFactsSchema.Encoded, PricingFacts>>,
]

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
	Rpc.make('pricingFacts', {
		payload: {
			email: Schema.NonEmptyString,
			productId: Schema.NonEmptyString,
			quantity: Quantity,
			orderKind: Schema.Literals(['individual', 'team']),
		},
		success: PricingFactsSchema,
		error: Failure,
	}),
)

const fail = (code: FailureCode) => Effect.fail({ code })

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
		// Read-only evidence. No price, grant, reservation, coupon or checkout.
		pricingFacts: (request) =>
			Effect.gen(function* () {
				const facts = yield* read(MaybePricingFacts, () =>
					hooks.pricingFacts({ ...request }),
				)
				if (!facts) return yield* fail('PRODUCT_NOT_SUPPORTED')
				const { order } = facts.facts
				if (
					facts.product.appProductId !== request.productId ||
					facts.quantity !== request.quantity ||
					('value' in order && order.value !== request.orderKind)
				)
					return yield* fail('INVALID_HOOK_RESULT')
				return facts
			}),
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
					const cause = JSON.stringify(message.exit.cause)
					const code =
						FAILURE_CODES.find((candidate) => cause.includes(candidate)) ??
						'INVALID_REQUEST'
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
