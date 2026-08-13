import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { LearnerFlowRecord } from "./drizzle-capture-repository";
import { summarizeLearnerFlowRecordPages } from "./learner-flow-summary";
import type { SideEffectIntent } from "./types";

const now = "2026-08-13T12:00:00.000Z";

function intent(
  id: string,
  overrides: Partial<SideEffectIntent> & {
    metadata?: Record<string, unknown>;
  } = {},
): SideEffectIntent {
  const { metadata, ...fields } = overrides;
  return {
    id,
    nextActionId: `action-${id}`,
    contactId: `contact-${id}`,
    provider: "kit",
    type: "send-value-path-email",
    status: "pending",
    completedAt: null,
    idempotencyKey: `key-${id}`,
    gates: [],
    reviewReasons: [],
    createdAt: "2026-08-13T11:00:00.000Z",
    ...fields,
    metadata: {
      valuePathSlug: "ai-hero-skills-workflow",
      emailResourceId: "ai-hero-skills-workflow.email-0",
      ...metadata,
    },
  };
}

function record(
  contactId: string,
  intents: SideEffectIntent[],
  overrides: Partial<LearnerFlowRecord> = {},
): LearnerFlowRecord {
  return {
    contactId,
    intents: intents.map((item) => ({ ...item, contactId })),
    entryEvents: [],
    ...overrides,
  };
}

describe("learner-flow aggregate summary", () => {
  it("classifies every record exactly once across bounded pages", async () => {
    const pages = (async function* () {
      yield [
        record("moving", [intent("moving")]),
        record("terminal", [
          intent("terminal", {
            status: "completed",
            completedAt: "2026-08-13T10:00:00.000Z",
            metadata: {
              emailResourceId: "ai-hero-skills-workflow.email-7",
            },
          }),
        ]),
      ];
      yield [
        record("blocked", [intent("blocked", { status: "blocked" })]),
        record("entry-only", [], {
          entryEvents: [
            {
              contactId: "entry-only",
              eventType: "value-path.entered",
              occurredAt: "2026-08-10T12:00:00.000Z",
              providerReference: "value-path:ai-hero-skills-workflow",
            } as LearnerFlowRecord["entryEvents"][number],
          ],
        }),
      ];
    })();

    const summary = await summarizeLearnerFlowRecordPages({ pages, now });

    expect(summary).toEqual({
      generatedAt: now,
      counts: {
        total: 4,
        moving: 1,
        terminal: 1,
        stuck: 2,
        accounted: 4,
      },
      causeCounts: {
        "blocked-intent": 1,
        "classifier-gap": 1,
      },
      assertion: {
        passed: true,
        expression: "moving + terminal + stuck = total contacts on course paths",
      },
    });
  });

  it("keeps aggregate computation independent from the server logger", () => {
    const source = readFileSync(
      new URL("./learner-flow-summary.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("@/server/logger");
    expect(source).not.toContain("log[");
  });
});
