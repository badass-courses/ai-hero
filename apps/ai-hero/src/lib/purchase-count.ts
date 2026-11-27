import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { products, purchases } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";
import { capacityPurchaseFilter, excludeC5CompsFromCapacity } from "./coupon-batches/capacity";

import { PRODUCT as C5_PRODUCT } from './coupon-batches/namespace';

/** Keep the legacy display rule for other products. A capped C5 product
 * never turns into the unlimited sentinel after the flag goes off. */
export function remainingFromPurchaseCount(productId: string, cap: number, count: number) {
  if (cap < 0) return -1;
  const remaining = cap - count;
  return remaining >= 0 ? remaining : productId === C5_PRODUCT ? 0 : -1;
}

export const PURCHASE_COUNTS_TAG = "purchase-counts";
export const PURCHASE_COUNT_REVALIDATE_SECONDS = 30;

/** Uncached row count for readers that already count each purchase as one. */
export async function readCapacityPurchaseCount(productId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(purchases)
    .where(and(eq(purchases.productId, productId), capacityPurchaseFilter(productId)));
  return row?.count ?? 0;
}

/** Only uncapped products may use a persisted count. Check the cap fresh,
 * rather than trusting a potentially cached product supplied by a caller.
 * Missing/unknown caps fail closed to the existing uncached count query.
 */
export async function getPurchaseCount(productId: string): Promise<number> {
  // Never cache a filtered count under the legacy key or serve one after a stop.
  if (excludeC5CompsFromCapacity(productId)) return readCapacityPurchaseCount(productId);
  const [product] = await db
    .select({ quantityAvailable: products.quantityAvailable })
    .from(products)
    .where(eq(products.id, productId));
  if (product?.quantityAvailable !== -1) return readCapacityPurchaseCount(productId);

  const cached = await unstable_cache(
    async () => {
      const cachedAt = Date.now();
      return { count: await readCapacityPurchaseCount(productId), cachedAt };
    },
    ["purchase-count", productId],
    {
      tags: [PURCHASE_COUNTS_TAG, `purchase-count:${productId}`],
      revalidate: PURCHASE_COUNT_REVALIDATE_SECONDS,
    },
  )();
  // unstable_cache uses stale-while-revalidate. Do not serve an older snapshot.
  return Date.now() - cached.cachedAt < PURCHASE_COUNT_REVALIDATE_SECONDS * 1000
    ? cached.count
    : readCapacityPurchaseCount(productId);
}
