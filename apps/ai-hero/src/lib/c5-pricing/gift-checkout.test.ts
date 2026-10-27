import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { createGiftCheckout } from "./gift-checkout";
import { encodeDecisionRef } from "./decision";
import { C5_PRODUCT_ID } from "./products";
import type { GiftCheckoutDeps } from "./gift-checkout";

const code = {
  codeRef: "test-reference",
  unitPrice: 40000,
  maxUses: 5,
  usesTaken: 4,
  expiresAt: "2030-03-01T00:00:00.000Z",
};
const params: Stripe.Checkout.SessionCreateParams = {
  mode: "payment",
  line_items: [{ price: "price_test", quantity: 1 }],
  expires_at: Date.parse("2030-04-01T00:00:00Z") / 1000,
  metadata: {
    productId: C5_PRODUCT_ID,
    bulk: "false",
    expectedTotalCents: "40000",
    decisionRef: encodeDecisionRef("0123456789abcdef", null, code.codeRef),
  },
};
function rig() {
  const create = vi.fn(
    async (_params: Stripe.Checkout.SessionCreateParams, _key?: string) =>
      ({ id: "cs_test" }) as Stripe.Checkout.Session,
  );
  const deps: GiftCheckoutDeps = {
    fact: vi.fn(async () => ({ value: code, sourceRefs: [] })),
    claim: vi.fn(async (input) => ({
      ...input,
      slot: 5,
      checkoutSessionId: null,
    })),
    bind: vi.fn(async () => {}),
    flag: vi.fn(async () => {}),
  };
  return { create, deps };
}
describe("gift provider boundary", () => {
  it("re-reads the cookie, claims before creation, binds, and caps lifetime", async () => {
    const { create, deps } = rig();
    await createGiftCheckout({ params, create, deps });
    expect(deps.claim).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      expires_at: Date.parse(code.expiresAt) / 1000,
      metadata: { codeRef: code.codeRef, basis: "code" },
    });
    expect(deps.bind).toHaveBeenCalledOnce();
  });
  it.each([2, 5])(
    "rejects a forced code session with quantity %s",
    async (quantity) => {
      const { create, deps } = rig();
      await expect(
        createGiftCheckout({
          params: {
            ...params,
            line_items: [{ price: "price_test", quantity }],
          },
          create,
          deps,
        }),
      ).rejects.toThrow("gift-quantity");
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("ignores a codeRef on a non-code request", async () => {
    const { create, deps } = rig();
    await createGiftCheckout({
      params: {
        ...params,
        metadata: { productId: C5_PRODUCT_ID, codeRef: code.codeRef },
      },
      create,
      deps,
    });
    expect(deps.fact).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });
  it("refuses missing/tampered cookies and exhausted reservations", async () => {
    const { create, deps } = rig();
    deps.fact = async () => ({ value: null, sourceRefs: [] });
    await expect(createGiftCheckout({ params, create, deps })).rejects.toThrow(
      "gift-unavailable",
    );
    expect(create).not.toHaveBeenCalled();
    deps.fact = async () => ({ value: code, sourceRefs: [] });
    deps.claim = async () => null;
    await expect(createGiftCheckout({ params, create, deps })).rejects.toThrow(
      "gift-unavailable",
    );
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps ambiguous provider failures reserved and flags bind failure without withholding a session", async () => {
    const { deps } = rig();
    await expect(
      createGiftCheckout({
        params,
        deps,
        create: async () => {
          throw new Error("ambiguous");
        },
      }),
    ).rejects.toThrow("ambiguous");
    deps.bind = async () => {
      throw new Error("db-down");
    };
    const { create } = rig();
    expect((await createGiftCheckout({ params, deps, create })).id).toBe(
      "cs_test",
    );
    expect(deps.flag).toHaveBeenCalledWith(
      "cs_test",
      "gift-reservation-bind-failed",
    );
  });
});
