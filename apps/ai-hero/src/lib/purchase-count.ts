import { unstable_cache } from "next/cache";
import { db } from "@/db";
import { products, purchases } from "@/db/schema";
import { count, eq } from "drizzle-orm";

export const PURCHASE_COUNTS_TAG = "purchase-counts";
export const PURCHASE_COUNT_REVALIDATE_SECONDS = 30;

async function readPurchaseCount(productId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(purchases)
    .where(eq(purchases.productId, productId));
  return row?.count ?? 0;
}

/** Only uncapped products may use a persisted count. Check the cap fresh,
 * rather than trusting a potentially cached product supplied by a caller.
 * Missing/unknown caps fail closed to the existing uncached count query.
 */
export async function getPurchaseCount(productId: string): Promise<number> {
  const [product] = await db
    .select({ quantityAvailable: products.quantityAvailable })
    .from(products)
    .where(eq(products.id, productId));
  if (product?.quantityAvailable !== -1) return readPurchaseCount(productId);

  const cached = await unstable_cache(
    async () => {
      const cachedAt = Date.now();
      return { count: await readPurchaseCount(productId), cachedAt };
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
    : readPurchaseCount(productId);
}
