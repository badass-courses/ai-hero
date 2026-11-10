import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unsubscribeLocalEmailPreferenceByUserId: vi.fn(),
  verifyKitPreferenceLinkLocally: vi.fn(),
  acceptKitLinkPreferenceChange: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/components/layout-client", () => ({ default: () => null }));
vi.mock("@/server/logger", () => ({ log: mocks.log }));
vi.mock("@/lib/email-preferences", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/email-preferences")
  >("@/lib/email-preferences");
  return {
    ...actual,
    unsubscribeLocalEmailPreferenceByUserId:
      mocks.unsubscribeLocalEmailPreferenceByUserId,
    verifyKitPreferenceLinkLocally: mocks.verifyKitPreferenceLinkLocally,
    acceptKitLinkPreferenceChange: mocks.acceptKitLinkPreferenceChange,
  };
});

import { unsubscribeAction } from "./actions";
import Unsubscribed from "./page";
import { UnsubscribeForm } from "./unsubscribe-form";

const identity = { ck_subscriber_id: "123", sh_kit: "abc" };

const render = (params: Record<string, string>) =>
  Unsubscribed({ searchParams: Promise.resolve(params) });

const findForm = (node: any): any => {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === UnsubscribeForm) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findForm(child);
    if (found) return found;
  }
  return undefined;
};

function expectNoWrites() {
  expect(mocks.acceptKitLinkPreferenceChange).not.toHaveBeenCalled();
  expect(mocks.unsubscribeLocalEmailPreferenceByUserId).not.toHaveBeenCalled();
}

describe("/unsubscribed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyKitPreferenceLinkLocally.mockResolvedValue({
      status: "verified",
    });
    mocks.acceptKitLinkPreferenceChange.mockResolvedValue({
      status: "accepted",
    });
    mocks.unsubscribeLocalEmailPreferenceByUserId.mockResolvedValue({
      userId: "u1",
    });
  });

  it.each(["cohorts", "cohort-004", "ohort-004"])(
    "%s makes no provider or local write",
    async (preference) => {
      await render({ preference, ...identity });
      await render({ preference, userId: "u1" });
      expectNoWrites();
      expect(mocks.verifyKitPreferenceLinkLocally).not.toHaveBeenCalled();
      expect(mocks.log.warn).not.toHaveBeenCalled();
    },
  );

  it("an unknown preference makes no write, logs it, and offers preferences", async () => {
    const result = (await render({ preference: "foo", ...identity })) as any;
    const local = (await render({ preference: "foo", userId: "u1" })) as any;

    expectNoWrites();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "email-preferences.unknown_preference",
      expect.objectContaining({ preference: "foo" }),
    );
    expect(result.props.managePreferencesHref).toBe(
      "/preferences?ck_subscriber_id=123&sh_kit=abc",
    );
    expect(local.props.managePreferencesHref).toBe("/preferences");
  });

  it("truncates a long unknown preference in the log", async () => {
    await render({ preference: "x".repeat(500), ...identity });

    expectNoWrites();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "email-preferences.unknown_preference",
      expect.objectContaining({ preference: "x".repeat(100) }),
    );
  });

  it("GET with a valid Kit identity writes nothing and renders the confirm form", async () => {
    const result = await render({ preference: "newsletter", ...identity });

    expectNoWrites();
    expect(mocks.verifyKitPreferenceLinkLocally).toHaveBeenCalledTimes(1);
    const form = findForm(result);
    expect(form?.props.hiddenFields).toEqual({
      preference: "newsletter",
      ck_subscriber_id: "123",
      sh_kit: "abc",
    });
    expect(form?.props.managePreferencesHref).toBe(
      "/preferences?ck_subscriber_id=123&sh_kit=abc",
    );
  });

  it("GET with a userId writes nothing and renders the confirm form", async () => {
    const result = await render({ preference: "newsletter", userId: "u1" });

    expectNoWrites();
    expect(findForm(result)?.props.hiddenFields).toEqual({
      preference: "newsletter",
      userId: "u1",
    });
  });

  it("GET redirects home on a bad Kit signature, with no writes", async () => {
    mocks.verifyKitPreferenceLinkLocally.mockResolvedValue({
      status: "invalid",
      reason: "hash-mismatch",
    });
    await expect(
      render({ preference: "newsletter", ...identity }),
    ).rejects.toThrow("redirect:/");
    expectNoWrites();
  });

  it("GET redirects home with no identity at all", async () => {
    await expect(render({ preference: "newsletter" })).rejects.toThrow(
      "redirect:/",
    );
    expectNoWrites();
  });
});

describe("unsubscribeAction (POST)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyKitPreferenceLinkLocally.mockResolvedValue({
      status: "verified",
    });
    mocks.acceptKitLinkPreferenceChange.mockResolvedValue({
      status: "accepted",
    });
    mocks.unsubscribeLocalEmailPreferenceByUserId.mockResolvedValue({
      userId: "u1",
    });
  });

  const post = (fields: Record<string, string>) => {
    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) formData.set(k, v);
    return unsubscribeAction({ status: "idle" }, formData);
  };

  it("accepts the opt-out for a valid Kit identity", async () => {
    const state = await post({ preference: "newsletter", ...identity });

    expect(state).toEqual({ status: "done" });
    expect(mocks.verifyKitPreferenceLinkLocally).toHaveBeenCalledTimes(1);
    expect(mocks.acceptKitLinkPreferenceChange).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: "123", subscribed: false }),
    );
  });

  it("unsubscribes a userId locally", async () => {
    const state = await post({ preference: "newsletter", userId: "u1" });

    expect(state).toEqual({ status: "done" });
    expect(mocks.unsubscribeLocalEmailPreferenceByUserId).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.acceptKitLinkPreferenceChange).not.toHaveBeenCalled();
  });

  it.each(["foo", "cohorts", "cohort-004"])(
    "redirects home and writes nothing for the %s preference",
    async (preference) => {
      await expect(post({ preference, ...identity })).rejects.toThrow(
        "redirect:/",
      );
      await expect(post({ preference, userId: "u1" })).rejects.toThrow(
        "redirect:/",
      );
      expectNoWrites();
      expect(mocks.verifyKitPreferenceLinkLocally).not.toHaveBeenCalled();
    },
  );

  it("redirects home on a bad Kit signature, with no writes", async () => {
    mocks.verifyKitPreferenceLinkLocally.mockResolvedValue({
      status: "invalid",
      reason: "hash-mismatch",
    });
    mocks.acceptKitLinkPreferenceChange.mockResolvedValue({
      status: "rejected",
      reason: "invalid-link",
    });
    await expect(
      post({ preference: "newsletter", ...identity }),
    ).rejects.toThrow("redirect:/");
    expect(mocks.unsubscribeLocalEmailPreferenceByUserId).not.toHaveBeenCalled();
  });

  it("redirects home with no identity, and when the userId is unknown", async () => {
    await expect(post({ preference: "newsletter" })).rejects.toThrow(
      "redirect:/",
    );
    mocks.unsubscribeLocalEmailPreferenceByUserId.mockResolvedValue(null);
    await expect(
      post({ preference: "newsletter", userId: "nope" }),
    ).rejects.toThrow("redirect:/");
  });
});
