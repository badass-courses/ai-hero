import "server-only";
import { acquireDatabaseConnection } from "@/db";
import { log } from "@/server/logger";
import type Stripe from "stripe";
import { decodeDecisionRef, giftCodeDigest } from "./decision";
import { expireGiftSlot, spendGiftSlot } from "./gift-slots";
import { C5_PRODUCT_ID } from "./products";

/** A paid order always proceeds; repair failures are flagged, not thrown. */
export async function settleGiftSession(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;
  if (metadata?.productId !== C5_PRODUCT_ID || !metadata.codeRef) return;
  try {
    if (
      decodeDecisionRef(metadata.decisionRef ?? "")?.codeDigest !==
      giftCodeDigest(metadata.codeRef)
    )
      throw new Error("gift-decision-mismatch");
    const connection = await acquireDatabaseConnection();
    try {
      if (session.payment_status === "paid") {
        if (
          !(await spendGiftSlot(
            connection,
            session.id,
            metadata.codeRef,
            metadata.giftClaimId,
          ))
        )
          throw new Error("gift-reservation-missing");
      } else if (session.status === "expired")
        await expireGiftSlot(connection, session.id);
    } finally {
      connection.release();
    }
  } catch (error) {
    await log
      .error("c5.gift.review_required", {
        sessionId: session.id,
        reason:
          error instanceof Error ? error.message : "gift-settlement-failed",
      })
      .catch(() => undefined);
  }
}
