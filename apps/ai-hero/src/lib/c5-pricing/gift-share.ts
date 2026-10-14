import "server-only";
import { db, acquireDatabaseConnection } from "@/db";
import { giftShareLink } from "@/db/schema";
import { eq } from "drizzle-orm";
import { readGiftCode, type GiftCode } from "./gift-slots";
import { C5_PRODUCT_ID } from "./products";
import { c5PricingClosed } from "./switch-server";
import { frontDeskData } from "./front-desk-client";
import { c5BuyerOpening } from "./buyer-opening";
import { c5OpeningWindow } from "./buyer-opening-server";
import { c5PricingDisabled } from "./config";
import { giftCheckoutOpen } from "./gift-window";

/** via selects public presentation only. No cookie is read or issued here. */
export async function giftSharePresentation(slug: string | undefined) {
  if (!slug || !/^[a-z0-9-]{1,50}$/.test(slug)) return null;
  const [share] = await db
    .select()
    .from(giftShareLink)
    .where(eq(giftShareLink.slug, slug))
    .limit(1);
  if (!share) return null;
  const firstName = share.firstName === null ? null : share.firstName.split(/\s+/)[0] ?? "";
  if (firstName !== null && !/^[\p{L}\p{M}'-]{1,100}$/u.test(firstName)) return null;
  const connection = await acquireDatabaseConnection();
  let code: GiftCode | null;
  try {
    code = await readGiftCode(
      connection,
      share.codeRef,
      C5_PRODUCT_ID,
      new Date(),
    );
  } finally {
    connection.release();
  }
  const policy = await frontDeskData()?.policy(C5_PRODUCT_ID);
  const opening = c5BuyerOpening({
    switchEnabled: !(await c5PricingClosed()),
    overrideDisabled: c5PricingDisabled(),
    window: await c5OpeningWindow(policy?.ok ? policy.value.policy : null),
    now: Date.now(),
    gift: code ? { verified: true, productId: C5_PRODUCT_ID, code } : null,
  });
  const closed = opening === 'closed';
  const available = Boolean(!closed && code && policy?.ok && code.usesTaken < code.maxUses && giftCheckoutOpen(code.expiresAt, policy.value.policy, Date.now()));
  return {
    firstName,
    available,
    closed: Boolean(closed),
    codeRef: share.codeRef,
    expiresAt: code?.expiresAt ?? null,
  };
}

export const giftShareTitle = (firstName: string | null, available: boolean) =>
  firstName === null ? (available ? "A gift for you" : "An AI Hero legend recommends") : available ? `Gift from ${firstName}` : `${firstName} recommends`;
