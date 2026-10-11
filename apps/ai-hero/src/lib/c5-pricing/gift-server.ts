import "server-only";
import { cookies } from "next/headers";
import { acquireDatabaseConnection } from "@/db";
import { env } from "@/env.mjs";
import { GIFT_COOKIE, openGiftCookie } from "./gift-cookie";
import { C5_PRODUCT_ID } from "./products";
import { noGift, readGiftCode, type GiftFact } from "./gift-slots";
import { frontDeskData } from "./server";
import { giftCheckoutOpen } from "./gift-window";

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
    try {
      const code = await readGiftCode(
        connection,
        payload.codeRef,
        productId,
        now,
      );
      const policy = code ? await frontDeskData()?.policy(productId) : undefined;
      if (code && !policy?.ok) return { gap: 'FactsUnavailable' };
      return {
        value: code && policy?.ok && giftCheckoutOpen(code.expiresAt, policy.value.policy, now.getTime()) ? code : null,
        sourceRefs: ["gift:signed-cookie", "gift:coupon-and-ledger"],
      };
    } finally {
      connection.release();
    }
  } catch {
    return { gap: "FactsUnavailable" };
  }
}
