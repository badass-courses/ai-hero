import { sha256, stableJson } from "../control-plane";
import { courseSyncSourceFields } from "../resource-fields";
import type { ResourcePlanItem, SyncPlan } from "../types";
import { syntheticCohortBinding } from "./cohort-binding";

export const subtreeBinding = {
  ...syntheticCohortBinding,
  contractVersion: 6,
  targetContract: {
    ...syntheticCohortBinding.targetContract,
    cohort: { type: "cohort", state: "published", visibility: "public" },
  },
} as const;

/** Synthetic shape only: no production IDs, content, titles, or source manifest. */
export function subtreeApplyFixture() {
  const resources: ResourcePlanItem[] = [];
  const previousFields = new Map<string, Record<string, unknown>>();
  function add(input: {
    kind: ResourcePlanItem["sourceKind"];
    id: string;
    parent: string;
    position: number;
    previousPosition?: number;
    previousParent?: string;
    action: ResourcePlanItem["action"];
    detached?: boolean;
    fields?: Record<string, unknown>;
  }) {
    const fields: Record<string, unknown> = {
      state: input.kind === "video" ? "ready" : "draft",
      visibility: "unlisted",
      courseSync: {
        bindingId: subtreeBinding.bindingId,
        ...(input.kind === "lesson" ? { lessonType: "placeholder" } : {}),
      },
      ...(["workshop", "lesson", "solution", "video"].includes(input.kind)
        ? {
            title: input.id,
            ...(input.kind === "video" ? {} : { slug: input.id }),
          }
        : {}),
      ...input.fields,
    };
    const old = {
      ...fields,
      ...(input.kind === "lesson"
        ? {
            courseSync: {
              bindingId: subtreeBinding.bindingId,
              lessonType: "placeholder",
            },
          }
        : {}),
      ...(input.action === "update" && !input.detached
        ? { title: `Before ${input.id}` }
        : {}),
    };
    if (input.action !== "create") {
      previousFields.set(input.id, {
        ...old,
        ...(input.kind === "workshop"
          ? { startsAt: "2026-12-01T08:00:00.000Z", timezone: "UTC" }
          : {}),
      });
    }
    const item: ResourcePlanItem = {
      sourceKind: input.kind,
      sourceId: input.id,
      targetResourceId: input.id,
      parentResourceId: input.parent,
      position: input.position,
      action: input.action,
      detached: input.detached ?? false,
      previousDetached: false,
      fields,
      previousVersionId:
        input.action === "create" ? null : `before-${input.id}`,
      previousFieldsSha256:
        input.action === "create"
          ? null
          : sha256(stableJson(courseSyncSourceFields(input.kind, old))),
      previousParentResourceId:
        input.action === "create"
          ? null
          : (input.previousParent ?? input.parent),
      previousPosition:
        input.action === "create"
          ? null
          : (input.previousPosition ?? input.position),
    };
    resources.push(item);
    return item;
  }

  const liveLessonCounts = [7, 10, 7, 10, 8, 8, 9];
  const removedLessonCounts = [0, 4, 1, 2, 2, 0, 0];
  const activeLessons: ResourcePlanItem[] = [];
  for (let group = 0; group < 7; group++) {
    const workshop = `workshop-${group}`;
    add({
      kind: "workshop",
      id: workshop,
      parent: subtreeBinding.anchorCohortId,
      position: group,
      previousPosition: group < 5 ? group : group + 1,
      action: "update",
    });
    const existingCount = liveLessonCounts[group]! - (group < 6 ? 1 : 0);
    for (let index = 0; index < existingCount; index++) {
      const filmedIndex = activeLessons.length;
      activeLessons.push(
        add({
          kind: "lesson",
          id: `lesson-${group}-${index}`,
          parent: workshop,
          position: group < 4 ? index + 1 : index,
          // One survivor moves between retained workshops, not merely within a parent.
          previousParent: group === 0 && index === 0 ? "workshop-3" : workshop,
          previousPosition:
            group === 0 ? (index === 0 ? 11 : index - 1) : index,
          action: group < 4 ? "update" : "retain",
          fields: {
            courseSync: {
              bindingId: subtreeBinding.bindingId,
              lessonType:
                filmedIndex < 14
                  ? "problem"
                  : filmedIndex < 24
                    ? "explainer"
                    : "placeholder",
            },
          },
        }),
      );
    }
    for (let index = 0; index < removedLessonCounts[group]!; index++) {
      add({
        kind: "lesson",
        id: `removed-${group}-${index}`,
        parent: workshop,
        position: existingCount + index,
        action: "update",
        detached: true,
      });
    }
    if (group < 6)
      add({
        kind: "lesson",
        id: `new-lesson-${group}`,
        parent: workshop,
        position: group < 4 ? 0 : existingCount,
        action: "create",
      });
  }

  for (const [group, count] of [11, 5, 7, 5, 5, 5, 6, 6].entries()) {
    const workshop = `archived-${group}`;
    add({
      kind: "workshop",
      id: workshop,
      parent: subtreeBinding.anchorCohortId,
      position: group === 0 ? 5 : group + 7,
      action: "update",
      detached: true,
    });
    for (let index = 0; index < count; index++)
      add({
        kind: "lesson",
        id: `archived-lesson-${group}-${index}`,
        parent: workshop,
        position: index,
        action: "update",
        detached: true,
      });
  }

  const media: SyncPlan["media"][number][] = [];
  function video(id: string, parent: string) {
    add({
      kind: "video",
      id,
      parent,
      position: 0,
      action: "create",
      fields: {
        muxAssetId: `asset-${id}`,
        muxPlaybackId: `playback-${id}`,
        duration: 1,
        chapters: [],
      },
    });
    media.push({
      sourceVideoId: id,
      providerRevision: `provider-${id}`,
      sha256: sha256(id),
      bytes: 1,
      action: "update",
      muxAssetId: `asset-${id}`,
      muxPlaybackId: `playback-${id}`,
      duration: 1,
    });
  }
  for (let index = 0; index < 24; index++) {
    const lesson = activeLessons[index]!;
    video(`video-${index}`, lesson.targetResourceId);
    if (index < 14) {
      const solution = `solution-${index}`;
      add({
        kind: "solution",
        id: solution,
        parent: lesson.targetResourceId,
        position: 1,
        action: "create",
        fields: { videoResourceId: `solution-video-${index}`, optional: false },
      });
      video(`solution-video-${index}`, solution);
    }
    if (index < 19)
      add({
        kind: "question",
        id: `question-${index}`,
        parent: lesson.targetResourceId,
        position: 2,
        action: "create",
      });
  }
  const input = {
    bindingId: subtreeBinding.bindingId,
    sourceRevisionId: "test-revision",
    courseVersionId: "test-course-version",
    resources,
    media,
    lessonRegressions: [],
  };
  return {
    plan: {
      ...input,
      planSha256: sha256(stableJson(input)),
    } satisfies SyncPlan,
    previousFields,
  };
}
