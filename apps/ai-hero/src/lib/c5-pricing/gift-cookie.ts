import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const GIFT_COOKIE = "c5_gift";
const Payload = z
  .object({
    v: z.literal(1),
    productId: z.string().min(1),
    codeRef: z.string().min(1).max(500),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GiftCookiePayload = z.infer<typeof Payload>;
const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(`c5-gift:${body}`).digest("base64url");

export function sealGiftCookie(payload: GiftCookiePayload, secret: string) {
  const body = Buffer.from(JSON.stringify(Payload.parse(payload))).toString(
    "base64url",
  );
  return `${body}.${sign(body, secret)}`;
}

/** Only a signed, product-scoped, unexpired cookie grants a code fact. */
export function openGiftCookie({
  value,
  secret,
  productId,
  now,
}: {
  value: string | undefined;
  secret: string;
  productId: string;
  now: number;
}): GiftCookiePayload | null {
  if (!value || value.length > 4096) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  try {
    const decoded = Payload.safeParse(
      JSON.parse(Buffer.from(body, "base64url").toString()),
    );
    return decoded.success &&
      decoded.data.productId === productId &&
      decoded.data.expiresAt > now
      ? decoded.data
      : null;
  } catch {
    return null;
  }
}
