import { db } from "@/db";
import { contentResourceProduct } from "@/db/schema";
import { revalidateProducts } from "@/lib/product-cache";
import { isMysqlDuplicateEntryError } from "@/lib/mysql-primary-key-retry";
import { and, eq, isNull } from "drizzle-orm";

/** Shared persistence for the CMS action and the authenticated bearer route.
 * Do not expose this as a server action: callers must authorize first.
 */
export async function attachProductResource(input: {
  productId: string;
  resourceId: string;
  addedBy: string;
}): Promise<{ position: number }> {
  const { productId, resourceId, addedBy } = input;
  const siblings = await db.query.contentResourceProduct.findMany({
    where: and(
      eq(contentResourceProduct.productId, productId),
      isNull(contentResourceProduct.deletedAt),
    ),
  });
  // Pre-existing CMS limitation: different resources can race for the same position.
  const position = siblings.length;

  const existing = await db.query.contentResourceProduct.findFirst({
    where: and(
      eq(contentResourceProduct.productId, productId),
      eq(contentResourceProduct.resourceId, resourceId),
    ),
  });

  if (existing) {
    if (!existing.deletedAt) return { position: existing.position };
    await db
      .update(contentResourceProduct)
      .set({ deletedAt: null, position })
      .where(
        and(
          eq(contentResourceProduct.productId, productId),
          eq(contentResourceProduct.resourceId, resourceId),
        ),
      );
    revalidateProducts();
    return { position };
  }

  await db.insert(contentResourceProduct).values({
    productId,
    resourceId,
    position,
    metadata: { addedBy },
  });

  revalidateProducts();
  return { position };
}

/** API-only duplicate-key recovery; CMS callers retain their existing behavior. */
export async function attachProductResourceIdempotently(
  input: Parameters<typeof attachProductResource>[0],
): Promise<{ position: number }> {
  try {
    return await attachProductResource(input);
  } catch (error) {
    if (!isMysqlDuplicateEntryError(error)) throw error;

    const existing = await db.query.contentResourceProduct.findFirst({
      where: and(
        eq(contentResourceProduct.productId, input.productId),
        eq(contentResourceProduct.resourceId, input.resourceId),
      ),
    });
    if (!existing || existing.deletedAt) throw error;
    return { position: existing.position };
  }
}
