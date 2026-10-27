import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSubscriberByEmail: vi.fn(),
  requestDoi: vi.fn(),
  readDrovrOptOuts: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  env: {} as Record<string, string | undefined>,
}));

vi.mock("@/env.mjs", () => ({ env: mocks.env }));
vi.mock("@/server/logger", () => ({ log: mocks.log }));
vi.mock("@/coursebuilder/email-list-provider", () => ({
  emailListProvider: { getSubscriberByEmail: mocks.getSubscriberByEmail },
}));
vi.mock("./drovr-doi-signup.server", () => ({
  requestDrovrDoiSignup: mocks.requestDoi,
}));

vi.mock("./drovr-opt-out-reader", () => ({
  readDrovrOptOuts: mocks.readDrovrOptOuts,
}));

import { routeReturningUnsubscriberWithKit } from "./ai-hero-email-opt-in.server";

const call = (kitFormId = 9376133) =>
  routeReturningUnsubscriberWithKit({
    email: "person@example.com",
    kitFormId,
    page: "https://www.aihero.dev/",
    entry: "form",
  });

describe("routeReturningUnsubscriberWithKit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.env)) delete mocks.env[key];
    mocks.getSubscriberByEmail.mockResolvedValue({
      state: "active",
      tags: [{ id: 8244351 }],
    });
    mocks.requestDoi.mockResolvedValue({ contactId: "contact-1" });
    mocks.readDrovrOptOuts.mockResolvedValue([]);
    mocks.env.AIH_RESUBSCRIBE_DOI_ENABLED = "true";
  });

  it("requests DOI with DROVR_DOI_FORMS unset, given drovr base URL and key", async () => {
    mocks.env.DROVR_API_BASE_URL = "https://drovr.test";
    mocks.env.DROVR_API_KEY_ORG_AIHERO = "drovr_key";

    await expect(call()).resolves.toEqual({ status: "doi-requested" });
    expect(mocks.requestDoi).toHaveBeenCalledWith(
      expect.objectContaining({ kitFormId: 9376133, entry: "form" }),
    );
  });

  it("blocks and logs doi-disabled when the flag is off, even with drovr configured", async () => {
    mocks.env.DROVR_API_BASE_URL = "https://drovr.test";
    mocks.env.DROVR_API_KEY_ORG_AIHERO = "drovr_key";
    mocks.env.AIH_RESUBSCRIBE_DOI_ENABLED = undefined;

    await expect(call()).resolves.toEqual({
      status: "blocked",
      reason: "doi-disabled",
    });
    expect(mocks.requestDoi).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith("optin.resubscribe.blocked", {
      formId: 9376133,
      reason: "doi-disabled",
      entry: "form",
    });
  });

  it("blocks and logs when drovr is not configured", async () => {
    await expect(call()).resolves.toEqual({
      status: "blocked",
      reason: "drovr-unconfigured",
    });
    expect(mocks.requestDoi).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "optin.resubscribe.blocked",
      expect.objectContaining({ reason: "drovr-unconfigured" }),
    );
  });

  it("keeps the tag and logs unmapped_form for a Kit form with no drovr form", async () => {
    mocks.env.DROVR_API_BASE_URL = "https://drovr.test";
    mocks.env.DROVR_API_KEY_ORG_AIHERO = "drovr_key";

    await expect(call(1)).resolves.toEqual({
      status: "blocked",
      reason: "unmapped-form",
    });
    expect(mocks.requestDoi).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "optin.resubscribe.unmapped_form",
      expect.any(Object),
    );
  });

  it("Kit lookup fails: continues, logs lookup_failed without the email", async () => {
    mocks.getSubscriberByEmail.mockRejectedValue(new Error("429"));

    await expect(call()).resolves.toEqual({ status: "lookup-failed" });
    expect(mocks.requestDoi).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "optin.resubscribe.lookup_failed",
      { formId: 9376133, entry: "form" },
    );
  });

  it("drovr-only unsubscribe requests DOI using the existing Kit subscriber id", async () => {
    mocks.env.DROVR_API_BASE_URL = "https://drovr.test";
    mocks.env.DROVR_API_KEY_ORG_AIHERO = "drovr_key";
    mocks.getSubscriberByEmail.mockResolvedValue({ id: 123, tags: [] });
    mocks.readDrovrOptOuts.mockResolvedValue([{ reason: "unsubscribed" }]);
    await expect(call()).resolves.toEqual({ status: "doi-requested" });
    expect(mocks.readDrovrOptOuts).toHaveBeenCalledWith("123", {
      baseUrl: "https://drovr.test", apiKey: "drovr_key",
    }, expect.any(Function));
  });

  it.each([true, false])("unknown drovr consent with DOI enabled=%s logs the error name and gate", async (doiEnabled) => {
    mocks.env.DROVR_API_BASE_URL = "https://drovr.test";
    mocks.env.DROVR_API_KEY_ORG_AIHERO = "drovr_key";
    mocks.env.AIH_RESUBSCRIBE_DOI_ENABLED = String(doiEnabled);
    mocks.getSubscriberByEmail.mockResolvedValue({ id: 123, tags: [] });
    mocks.readDrovrOptOuts.mockRejectedValue(new TypeError("private@example.test secret"));
    await expect(call()).resolves.toEqual(doiEnabled
      ? { status: "doi-requested" }
      : { status: "blocked", reason: "drovr-unknown" });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "optin.resubscribe.drovr_unknown", { error: "TypeError", doiEnabled },
    );
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain("private@example.test");
    expect(mocks.requestDoi).toHaveBeenCalledTimes(doiEnabled ? 1 : 0);
  });

  it("wires the unexpected-page warning without ids", async () => {
    mocks.getSubscriberByEmail.mockResolvedValue({ id: 123, tags: [] });
    mocks.readDrovrOptOuts.mockImplementationOnce(async (_id, _config, onUnexpectedPage) => {
      await onUnexpectedPage();
      return [];
    });
    await expect(call()).resolves.toEqual({ status: "not-unsubscribed" });
    expect(mocks.log.warn).toHaveBeenCalledWith("optin.resubscribe.drovr_unexpected_page", {});
  });

  it("untagged: nothing requested, nothing logged", async () => {
    mocks.getSubscriberByEmail.mockResolvedValue({ state: "active", tags: [] });
    await expect(call()).resolves.toEqual({ status: "not-unsubscribed" });
    expect(mocks.requestDoi).not.toHaveBeenCalled();
  });
});
