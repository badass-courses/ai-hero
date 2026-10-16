import { ImageResponse } from "next/og";
import { db } from "@/db";
import { products } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  giftSharePresentation,
  giftShareTitle,
} from "@/lib/c5-pricing/gift-share";
import { C5_PRODUCT_ID } from "@/lib/c5-pricing/products";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const via = new URL(request.url).searchParams.get("via") ?? undefined;
  const share = await giftSharePresentation(via).catch(() => null);
  const [product] = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, C5_PRODUCT_ID))
    .limit(1);
  const title = product?.name ?? "AI Hero";
  const response = new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        padding: 64,
        background: "black",
        color: "white",
        fontFamily: "sans-serif",
      }}
    >
      {share ? (
        <div style={{ display: "flex", fontSize: 42 }}>
          {giftShareTitle(share.firstName, share.available)}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          fontSize: 64,
          fontWeight: 700,
          marginTop: 24,
        }}
      >
        {title}
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
