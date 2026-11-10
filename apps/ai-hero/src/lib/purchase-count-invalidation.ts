import { revalidateTag } from "next/cache";
import { log } from "@/server/logger";
import type { PurchasePort } from "@coursebuilder/core/ports";

export const purchaseCountWriteMethods = [
  "createPurchase",
  "createMerchantChargeAndPurchase",
  "redeemFullPriceCoupon",
  "updatePurchaseStatusForCharge",
  "transferPurchaseToUser",
  "transferPurchasesToNewUser",
] as const satisfies readonly (keyof PurchasePort)[];

/** Count all rows, including refunded/transferred rows, just as before.
 * Bust the shared tag as well as keeping per-product tags on the reads:
 * charge-based writes do not always return a product ID.
 */
export async function invalidatePurchaseCounts() {
  try {
    revalidateTag("purchase-counts", { expire: 0 });
  } catch {
    try {
      await log.warn("purchase_count.invalidation_failed");
    } catch {
      // Logging must not turn a completed commerce write into a failure.
    }
  }
}

export function withPurchaseCountInvalidation<T extends PurchasePort>(
  adapter: T,
  invalidate: () => Promise<void> = invalidatePurchaseCounts,
): T {
  const wrapped = { ...adapter };
  for (const method of purchaseCountWriteMethods) {
    const original = adapter[method];
    Object.assign(wrapped, {
      [method]: async (...args: unknown[]) => {
        const result = await (
          original as (...args: unknown[]) => unknown
        ).apply(adapter, args);
        try {
          await invalidate();
        } catch {
          try {
            await log.warn("purchase_count.invalidation_failed");
          } catch {}
        }
        return result;
      },
    });
  }
  return wrapped;
}
