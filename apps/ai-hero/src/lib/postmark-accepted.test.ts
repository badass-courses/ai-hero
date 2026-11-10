import { describe, expect, it } from "vitest";

import { assertPostmarkAccepted } from "./postmark-accepted";

describe("assertPostmarkAccepted", () => {
  it("accepts ErrorCode 0", () => {
    expect(() =>
      assertPostmarkAccepted({ ErrorCode: 0, Message: "OK", MessageID: "x" }),
    ).not.toThrow();
  });

  it("throws on a non-zero ErrorCode", () => {
    expect(() =>
      assertPostmarkAccepted({ ErrorCode: 406, Message: "Inactive recipient" }),
    ).toThrow("Postmark rejected the email: 406 Inactive recipient");
  });

  it("ignores responses without ErrorCode, such as SKIP_EMAIL options", () => {
    expect(() => assertPostmarkAccepted({ To: "a@b.c" })).not.toThrow();
    expect(() => assertPostmarkAccepted(undefined)).not.toThrow();
  });
});
