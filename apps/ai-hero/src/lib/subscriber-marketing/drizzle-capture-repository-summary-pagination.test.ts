import { contact, contactEvent, contactState, sideEffectIntent } from "@/db/schema";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  DrizzleCaptureMarketingRepository,
  LEARNER_FLOW_RECORD_PAGE_SIZE,
} from "./drizzle-capture-repository";

const intentRow = (contactId: string) => ({
  id: `intent-${contactId}`,
  nextActionId: `action-${contactId}`,
  contactId,
  provider: "kit",
  type: "send-value-path-email",
  status: "pending",
  completedAt: null,
  idempotencyKey: `key-${contactId}`,
  gates: [],
  reviewReasons: [],
  metadata: {
    valuePathSlug: "ai-hero-skills-workflow",
    emailResourceId: "ai-hero-skills-workflow.email-0",
  },
  createdAt: "2026-08-13T11:00:00.000Z",
});

const contactRow = (id: string) => ({
  id,
  userId: null,
  email: `${id}@example.com`,
  name: null,
  lifecycle: "new",
  isProvisional: true,
  optInAttribution: null,
  createdAt: "2026-08-13T10:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
});

describe("learner-flow summary pagination", () => {
  it("bounds the learner-id and related-row selects for every page", async () => {
    const firstIds = Array.from({ length: LEARNER_FLOW_RECORD_PAGE_SIZE }, (_, index) => ({
      contactId: `contact-${String(index).padStart(4, "0")}`,
    }));
    const lastIds = [{ contactId: "contact-z" }];
    const idQueries: Array<{ condition: unknown; limit: number }> = [];
    const relatedQueries: Array<{ table: unknown; condition: unknown }> = [];
    const intentQueries: Array<{ condition: unknown; limit: number }> = [];
    let idPage = 0;
    const database = {
      selectDistinct: (selection: unknown) => ({
        from: () => ({
          where: () => ({
            union: () => ({ as: () => ({ contactId: selection && {} }) }),
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => {
          const related =
            table === sideEffectIntent ||
            table === contactEvent ||
            table === contact ||
            table === contactState;
          return {
            where: (condition: unknown) => {
              if (table === sideEffectIntent) {
                return {
                  orderBy: () => ({
                    limit: (limit: number) => {
                      intentQueries.push({ condition, limit });
                      const ids = idPage === 1 ? firstIds : lastIds;
                      return ids.map(({ contactId }) => intentRow(contactId));
                    },
                  }),
                };
              }
              if (related) {
                relatedQueries.push({ table, condition });
                if (table === contact) {
                  const ids = idPage === 1 ? firstIds : lastIds;
                  return ids.map(({ contactId }) => contactRow(contactId));
                }
                return [];
              }
              return {
                orderBy: () => ({
                  limit: (limit: number) => {
                    idQueries.push({ condition, limit });
                    const result = idPage === 0 ? firstIds : lastIds;
                    idPage += 1;
                    return result;
                  },
                }),
              };
            },
          };
        },
      }),
    };
    const repository = new DrizzleCaptureMarketingRepository(database);

    const pages = [];
    for await (const page of repository.findSkillsWorkflowLearnerFlowRecordPages()) {
      pages.push(page);
    }

    expect(pages.map((page) => page.length)).toEqual([LEARNER_FLOW_RECORD_PAGE_SIZE, 1]);
    expect(idQueries).toHaveLength(2);
    expect(idQueries.every(({ limit }) => limit === LEARNER_FLOW_RECORD_PAGE_SIZE)).toBe(true);
    const secondIdQuery = new MySqlDialect().sqlToQuery(
      idQueries[1]?.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(secondIdQuery.sql).toContain(">");
    expect(secondIdQuery.params).toContain(firstIds[LEARNER_FLOW_RECORD_PAGE_SIZE - 1]?.contactId);
    expect(intentQueries).toHaveLength(2);
    expect(intentQueries.every(({ limit }) => limit === 5000)).toBe(true);
    expect(relatedQueries).toHaveLength(6);
    for (const query of relatedQueries) {
      const rendered = new MySqlDialect().sqlToQuery(
        query.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
      );
      expect(rendered.sql).toContain(" in ");
    }
  });
});
