import { describe, it, expect } from "vitest";
import { openGiftCookie, sealGiftCookie } from "./gift-cookie";
import {
  decodeDecisionRef,
  encodeDecisionRef,
  giftCodeDigest,
} from "./decision";

const payload = {
  v: 1 as const,
  productId: "test-product",
  codeRef: "test-reference",
  expiresAt: 2000,
};
const secret = "synthetic-cookie-key";
const read = (value: string, productId = payload.productId, now = 1000) =>
  openGiftCookie({ value, secret, productId, now });
describe("gift cookie trust boundary", () => {
  it("accepts signed, product-scoped, live cookies", () =>
    expect(read(sealGiftCookie(payload, secret))).toEqual(payload));
  it("ignores tampered, wrong-product, expired and malformed cookies", () => {
    const cookie = sealGiftCookie(payload, secret);
    expect(read(cookie + "x")).toBeNull();
    expect(read(cookie, "other-product")).toBeNull();
    expect(read(cookie, payload.productId, 2000)).toBeNull();
    expect(read("malformed")).toBeNull();
  });
  it("supports a 500-character code reference without overflowing decision metadata", () => {
    const codeRef = "x".repeat(500);
    const ref = encodeDecisionRef("0123456789abcdef", null, codeRef);
    expect(ref.length).toBeLessThanOrEqual(500);
    expect(decodeDecisionRef(ref)?.codeDigest).toBe(giftCodeDigest(codeRef));
    expect(read(sealGiftCookie({ ...payload, codeRef }, secret))?.codeRef).toBe(
      codeRef,
    );
  });
});
