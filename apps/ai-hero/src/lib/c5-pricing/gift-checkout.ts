import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { decodeDecisionRef, giftCodeDigest } from "./decision";
import { C5_PRODUCT_ID } from "./products";
import type { GiftClaim, GiftFact } from "./gift-slots";

type Params = Stripe.Checkout.SessionCreateParams;
export type GiftCheckoutDeps = {
  fact: () => Promise<GiftFact>;
  claim: (input: {
    codeRef: string;
    claimId: string;
    quantity: number;
    expiresAt: number;
    unitPrice: number;
  }) => Promise<GiftClaim | null>;
  bind: (claim: GiftClaim, sessionId: string) => Promise<void>;
  flag: (sessionId: string, reason: string) => Promise<void>;
};

/** Provider boundary: neither a body codeRef nor via can select a code. */
export async function createGiftCheckout<
  Session extends Stripe.Checkout.Session,
>({
  params,
  idempotencyKey,
  create,
  deps,
}: {
  params: Params;
  idempotencyKey?: string;
  create: (params: Params, idempotencyKey?: string) => Promise<Session>;
  deps: GiftCheckoutDeps;
}) {
  const ref =
    typeof params.metadata?.decisionRef === "string"
      ? decodeDecisionRef(params.metadata.decisionRef)
      : null;
  if (!ref?.codeDigest) {
    const {
      codeRef: _code,
      giftClaimId: _claim,
      giftSlot: _slot,
      ...metadata
    } = params.metadata ?? {};
    const {
      codeRef: _intentCode,
      giftClaimId: _intentClaim,
      giftSlot: _intentSlot,
      ...intentMetadata
    } = params.payment_intent_data?.metadata ?? {};
    return create(
      {
        ...params,
        metadata,
        ...(params.payment_intent_data
          ? {
              payment_intent_data: {
                ...params.payment_intent_data,
                metadata: intentMetadata,
              },
            }
          : {}),
      },
      idempotencyKey,
    );
  }
  if (params.metadata?.productId !== C5_PRODUCT_ID)
    throw new Error("gift-product-mismatch");
  if (
    params.line_items?.length !== 1 ||
    params.line_items[0]?.quantity !== 1 ||
    params.metadata?.bulk !== "false"
  )
    throw new Error("gift-quantity-must-be-one");
  const fact = await deps.fact();
  const code = "value" in fact ? fact.value : null;
  if (!code || giftCodeDigest(code.codeRef) !== ref.codeDigest)
    throw new Error("gift-unavailable");
  if (Number(params.metadata?.expectedTotalCents) !== code.unitPrice)
    throw new Error("gift-price-mismatch");
  const claimId = idempotencyKey
    ? createHash("sha256").update(`gift:${idempotencyKey}`).digest("hex")
    : randomUUID();
  const expiresAt = Math.min(
    params.expires_at ?? Infinity,
    Math.floor(Date.parse(code.expiresAt) / 1000),
  );
  const claim = await deps.claim({
    codeRef: code.codeRef,
    claimId,
    quantity: 1,
    expiresAt,
    unitPrice: code.unitPrice,
  });
  if (!claim) throw new Error("gift-unavailable");
  const metadata = {
    ...params.metadata,
    codeRef: code.codeRef,
    basis: "code",
    giftClaimId: claim.claimId,
    giftSlot: String(claim.slot),
  };
  // Ambiguous provider failures retain the reservation. Never blindly release.
  const session = await create(
    {
      ...params,
      expires_at: claim.expiresAt,
      metadata,
      payment_intent_data: {
        ...params.payment_intent_data,
        metadata: { ...params.payment_intent_data?.metadata, ...metadata },
      },
    },
    idempotencyKey ?? `gift-${claim.claimId}`,
  );
  try {
    await deps.bind(claim, session.id);
  } catch {
    await deps.flag(session.id, "gift-reservation-bind-failed");
  }
  return session;
}
