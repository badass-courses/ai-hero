import "server-only";
import { cookies } from "next/headers";
import { acquireDatabaseConnection } from "@/db";
import { env } from "@/env.mjs";
import { GIFT_COOKIE, openGiftCookie } from "./gift-cookie";
import { C5_PRODUCT_ID } from "./products";
import { noGift, readGiftCode, type GiftFact } from "./gift-slots";
import { frontDeskData } from "./front-desk-client";
import { giftCheckoutOpen } from "./gift-window";
import { c5BuyerOpening } from "./buyer-opening";
import { c5OpeningWindow } from "./buyer-opening-server";
import { c5PricingClosed } from "./switch-server";
import { c5PricingDisabled } from "./config";
import type { GiftCode } from "./gift-slots";

/** Display reuses a verified fact, but checks the switch and both windows fresh. */
export async function giftEnrollmentAccess(code: GiftCode | null) {
  if (!code) return false;
  const policy = await frontDeskData()?.policy(C5_PRODUCT_ID);
  const window = await c5OpeningWindow(policy?.ok ? policy.value.policy : null);
  if (!window) return false;
  return c5BuyerOpening({
    switchEnabled: !(await c5PricingClosed()), overrideDisabled: c5PricingDisabled(),
    now: Date.now(),
    window,
    gift: { verified: true, productId: C5_PRODUCT_ID, code },
  }) !== 'closed';
}

/** Fresh every time, outside the buyer display cache. No query/body input. */
export async function signedGiftFact(
  productId = C5_PRODUCT_ID,
): Promise<GiftFact> {
  if (productId !== C5_PRODUCT_ID) return noGift();
  let value: string | undefined;
  try {
    value = (await cookies()).get(GIFT_COOKIE)?.value;
  } catch {
    return noGift();
  }
  const now = new Date();
  const payload = openGiftCookie({
    value,
    secret: env.NEXTAUTH_SECRET,
    productId,
    now: now.getTime(),
  });
  if (!payload) return noGift();
  try {
    const connection = await acquireDatabaseConnection();
    let code: GiftCode | null;
    try {
      code = await readGiftCode(
        connection,
        payload.codeRef,
        productId,
        now,
      );
    } finally {
      connection.release();
    }
    const policy = code ? await frontDeskData()?.policy(productId) : undefined;
    if (code && !policy?.ok) return { gap: 'FactsUnavailable' };
    const opening = c5BuyerOpening({
      switchEnabled: !(await c5PricingClosed()),
      overrideDisabled: c5PricingDisabled(),
      now: now.getTime(),
      window: await c5OpeningWindow(policy?.ok ? policy.value.policy : null),
      gift: code ? { verified: true, productId, code } : null,
    });
    return {
      value: opening !== 'closed' && code && code.usesTaken < code.maxUses && policy?.ok && giftCheckoutOpen(code.expiresAt, policy.value.policy, now.getTime()) ? code : null,
      sourceRefs: ["gift:signed-cookie", "gift:coupon-and-ledger"],
    };
  } catch {
    return { gap: "FactsUnavailable" };
  }
}
