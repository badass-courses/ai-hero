import { db } from "@/db";
import { contentResourceProduct } from "@/db/schema";
import { revalidateProducts } from "@/lib/product-cache";
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
