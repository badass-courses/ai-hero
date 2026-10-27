import { beforeEach, describe, expect, it, vi } from "vitest";

import { syntheticCohortBinding } from "./test-fixtures/cohort-binding";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  findFirst: vi.fn(),
  binding: null as unknown,
}));

vi.mock("@/db", () => ({
  db: {
    select: mocks.select,
    query: { contentResource: { findFirst: mocks.findFirst } },
  },
}));
vi.mock("@/env.mjs", () => ({
  env: { NEXT_PUBLIC_URL: "https://example.test" },
}));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/coursebuilder/slack-provider", () => ({
  slackProvider: { sendNotification: vi.fn(), defaultChannelId: "C" },
}));
vi.mock("./cohort-entitlements", () => ({
  deliverCourseSyncEntitlementSync: vi.fn(),
}));
vi.mock("./detection-persistence", () => ({
  claimCourseSyncReviewNotification: vi.fn(),
  completeCourseSyncReviewNotification: vi.fn(),
  failCourseSyncReviewNotification: vi.fn(),
  getCourseSyncPlanChanges: vi.fn(),
}));
vi.mock("./narrate", () => ({
  COURSE_SYNC_AUTHOR_NAME: "x",
  narrateCourseSyncApply: vi.fn(),
}));
vi.mock("./run-binding", () => ({
  getCourseSyncRunBinding: async () => mocks.binding,
}));

import { buildCourseSyncAppliedNotification } from "./applied-notice";
import { resolveCourseSyncEditorLink } from "./editor-link";
import {
  AI_HERO_COURSE_SYNC_BINDING,
  AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
} from "./types";

const workshopBinding = AI_HERO_COURSE_SYNC_BINDING;

describe("resolveCourseSyncEditorLink", () => {
  it("links a workshop binding to its anchor workshop editor", async () => {
    const lookup = vi.fn(async () => "some-workshop");
    const link = await resolveCourseSyncEditorLink(
      workshopBinding,
      "version-1",
      lookup,
    );
    expect(lookup).toHaveBeenCalledWith(workshopBinding.anchorWorkshopId);
    expect(link).toEqual({
      url: "https://example.test/workshops/some-workshop/edit",
      label: "Open the workshop editor",
    });
  });

  it("links a cohort binding to its anchor cohort editor with the cohort label", async () => {
    const lookup = vi.fn(async () => "cohort-slug");
    const link = await resolveCourseSyncEditorLink(
      syntheticCohortBinding,
      "version-1",
      lookup,
    );
    expect(lookup).toHaveBeenCalledWith(syntheticCohortBinding.anchorCohortId);
    expect(link).toEqual({
      url: "https://example.test/cohorts/cohort-slug/edit",
      label: "Open the cohort editor",
    });
  });

  it("resolves the real cohort 005 binding to a cohort editor", async () => {
    const link = await resolveCourseSyncEditorLink(
      AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
      "version-1",
      async () => "resolved-slug",
    );
    expect(link.url).toBe("https://example.test/cohorts/resolved-slug/edit");
    expect(link.label).toBe("Open the cohort editor");
  });

  it.each([
    ["missing", async () => null],
    ["failing", async () => Promise.reject(new Error("db down"))],
  ])(
    "falls back to the run page when the anchor lookup is %s",
    async (_n, lookup) => {
      const link = await resolveCourseSyncEditorLink(
        syntheticCohortBinding,
        "version-1",
        lookup,
      );
      expect(link.url).toBe("https://example.test/admin/course-sync/version-1");
      expect(link.url).not.toContain("/edit");
    },
  );
});

describe("applied notice uses the same helper", () => {
  beforeEach(() => {
    mocks.binding = syntheticCohortBinding;
    mocks.findFirst.mockResolvedValue({ fields: { slug: "real-cohort" } });
    const run = {
      runId: "run-1",
      courseVersionId: "version-9",
      state: "applied",
      sourceRevisionId: "rev-1",
      createdAt: new Date(0),
      updatedAt: new Date(1000),
      plan: { resources: [], media: [] },
    };
    const revision = {
      providerRevision: "p",
      manifestSha256: "m",
      manifest: { courseName: "C", sections: [] },
    };
    mocks.select
      .mockReturnValueOnce(chain(run))
      .mockReturnValueOnce(chain(revision));
  });

  it("builds the cohort editor link from the run binding", async () => {
    const notice = await buildCourseSyncAppliedNotification("run-1", "poll-1");
    expect(notice?.editor).toEqual({
      url: "https://example.test/cohorts/real-cohort/edit",
      label: "Open the cohort editor",
    });
  });

  it("falls back to the run page when the anchor has no slug", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const notice = await buildCourseSyncAppliedNotification("run-1", "poll-1");
    expect(notice?.editor.url).toBe(
      "https://example.test/admin/course-sync/version-9",
    );
  });
});

function chain(row: unknown) {
  return { from: () => ({ where: () => ({ limit: async () => [row] }) }) };
}
