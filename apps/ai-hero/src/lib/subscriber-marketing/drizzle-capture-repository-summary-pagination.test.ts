import { contact, contactEvent, contactState, sideEffectIntent } from "@/db/schema";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  DrizzleCaptureMarketingRepository,
  LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE,
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

describe("learner-flow summary pagination", () => {
  it("bounds the learner-id and related-row selects for every page", async () => {
    const firstIds = Array.from({ length: LEARNER_FLOW_RECORD_PAGE_SIZE }, (_, index) => ({
      contactId: `contact-${String(index).padStart(4, "0")}`,
    }));
    const secondIds = Array.from(
      { length: LEARNER_FLOW_RECORD_PAGE_SIZE },
      (_, index) => ({
        contactId: `contact-${String(index + LEARNER_FLOW_RECORD_PAGE_SIZE).padStart(4, "0")}`,
      }),
    );
    const lastIds = [{ contactId: "contact-z" }];
    const idPages = [firstIds, secondIds, lastIds];
    const idQueries: Array<{ condition: unknown; limit: number }> = [];
    const relatedQueries: Array<{
      table: unknown;
      condition: unknown;
      selection: Record<string, unknown> | undefined;
    }> = [];
    const eventQueries: Array<{ condition: unknown; limit: number }> = [];
    const intentQueries: Array<{
      condition: unknown;
      limit: number;
      selection: Record<string, unknown> | undefined;
    }> = [];
    let idPage = 0;
    let hydrationPage = 0;
    const database = {
      selectDistinct: (selection: unknown) => ({
        from: () => ({
          where: () => ({
            union: () => ({ as: () => ({ contactId: selection && {} }) }),
          }),
        }),
      }),
      select: (selection?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const related =
            table === sideEffectIntent ||
            table === contactEvent ||
            table === contactState;
          return {
            where: (condition: unknown) => {
              if (table === sideEffectIntent) {
                return {
                  orderBy: () => ({
                    limit: (limit: number) => {
                      intentQueries.push({ condition, limit, selection });
                      const ids = idPages[hydrationPage] ?? [];
                      return ids.map(({ contactId }) => intentRow(contactId));
                    },
                  }),
                };
              }
              if (related) {
                relatedQueries.push({ table, condition, selection });
                if (table === contactEvent) {
                  return {
                    orderBy: () => ({
                      limit: (limit: number) => {
                        eventQueries.push({ condition, limit });
                        return [];
                      },
                    }),
                  };
                }
                if (table === contactState) hydrationPage += 1;
                return [];
              }
              return {
                orderBy: () => ({
                  limit: (limit: number) => {
                    idQueries.push({ condition, limit });
                    const result = idPages[idPage] ?? [];
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

    expect(pages.map((page) => page.length)).toEqual([
      LEARNER_FLOW_RECORD_PAGE_SIZE,
      LEARNER_FLOW_RECORD_PAGE_SIZE,
      1,
    ]);
    expect(idQueries).toHaveLength(3);
    expect(idQueries.every(({ limit }) => limit === LEARNER_FLOW_RECORD_PAGE_SIZE)).toBe(true);
    const dialect = new MySqlDialect();
    const secondIdQuery = dialect.sqlToQuery(
      idQueries[1]?.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    const thirdIdQuery = dialect.sqlToQuery(
      idQueries[2]?.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(secondIdQuery.sql).toContain(">");
    expect(secondIdQuery.params).toContain(firstIds[LEARNER_FLOW_RECORD_PAGE_SIZE - 1]?.contactId);
    expect(thirdIdQuery.params).toContain(secondIds[LEARNER_FLOW_RECORD_PAGE_SIZE - 1]?.contactId);
    expect(intentQueries).toHaveLength(3);
    expect(intentQueries.every(({ limit }) => limit === 5000)).toBe(true);
    for (const query of intentQueries) {
      expect(Object.keys(query.selection ?? {}).sort()).toEqual([
        "completedAt",
        "contactId",
        "createdAt",
        "id",
        "metadata",
        "provider",
        "reviewReasons",
        "status",
        "type",
      ]);
    }
    expect(eventQueries).toHaveLength(3);
    expect(
      eventQueries.every(
        ({ limit }) => limit === LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE,
      ),
    ).toBe(true);
    expect(relatedQueries).toHaveLength(6);
    expect(relatedQueries.some(({ table }) => table === contact)).toBe(false);
    for (const query of relatedQueries.filter(({ table }) => table === contactState)) {
      expect(Object.keys(query.selection ?? {}).sort()).toEqual([
        "contactId",
        "humanReview",
        "lifecycle",
      ]);
    }
    for (const query of relatedQueries.filter(({ table }) => table === contactEvent)) {
      expect(Object.keys(query.selection ?? {}).sort()).toEqual([
        "contactId",
        "eventType",
        "id",
        "occurredAt",
        "providerReference",
      ]);
    }
    for (const query of relatedQueries) {
      const rendered = new MySqlDialect().sqlToQuery(
        query.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
      );
      expect(rendered.sql).toContain(" in ");
    }
  });

  it("keyset-pages projected intents inside one learner page", async () => {
    const contactId = "intent-heavy";
    const fullPage = Array.from({ length: 5000 }, (_, index) => ({
      ...intentRow(contactId),
      id: `intent-${String(index).padStart(6, "0")}`,
    }));
    const lastPage = [
      { ...intentRow(contactId), id: "intent-z-1" },
      { ...intentRow(contactId), id: "intent-z-2" },
    ];
    const intentPages = [fullPage, lastPage];
    const intentQueries: Array<{
      selection: Record<string, unknown> | undefined;
      condition: unknown;
      limit: number;
    }> = [];
    let idPage = 0;
    const database = {
      selectDistinct: (selection: unknown) => ({
        from: () => ({
          where: () => ({
            union: () => ({ as: () => ({ contactId: selection && {} }) }),
          }),
        }),
      }),
      select: (selection?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table === sideEffectIntent) {
              return {
                orderBy: () => ({
                  limit: (limit: number) => {
                    intentQueries.push({ selection, condition, limit });
                    return intentPages[intentQueries.length - 1] ?? [];
                  },
                }),
              };
            }
            if (table === contactEvent) {
              return { orderBy: () => ({ limit: () => [] }) };
            }
            if (table === contact || table === contactState) return [];
            return {
              orderBy: () => ({
                limit: () => {
                  const result = idPage === 0 ? [{ contactId }] : [];
                  idPage += 1;
                  return result;
                },
              }),
            };
          },
        }),
      }),
    };
    const repository = new DrizzleCaptureMarketingRepository(database);

    const pages = [];
    for await (const page of repository.findSkillsWorkflowLearnerFlowRecordPages()) {
      pages.push(page);
    }

    expect(pages[0]?.[0]?.intents).toHaveLength(5002);
    expect(intentQueries).toHaveLength(2);
    expect(intentQueries.every(({ limit }) => limit === 5000)).toBe(true);
    const secondQuery = new MySqlDialect().sqlToQuery(
      intentQueries[1]?.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(secondQuery.sql).toContain("`id` >");
    expect(secondQuery.params).toContain(fullPage[4999]?.id);
  });

  it("keyset-pages projected entry events inside one learner page", async () => {
    const contactId = "entry-heavy";
    const fullPage = Array.from(
      { length: LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE },
      (_, index) => ({
        id: `event-${String(index).padStart(6, "0")}`,
        contactId,
        eventType: "value-path.entered",
        providerReference: "value-path:ai-hero-skills-workflow",
        occurredAt: "2026-08-13T11:00:00.000Z",
      }),
    );
    const lastPage = [
      {
        id: "event-z-1",
        contactId,
        eventType: "value-path.entered",
        providerReference: "value-path:ai-hero-skills-workflow",
        occurredAt: "2026-08-13T12:00:00.000Z",
      },
      {
        id: "event-z-2",
        contactId,
        eventType: "value-path.entered",
        providerReference: "value-path:ai-hero-skills-workflow",
        occurredAt: "2026-08-13T13:00:00.000Z",
      },
    ];
    const eventPages = [fullPage, lastPage];
    const eventQueries: Array<{
      selection: Record<string, unknown> | undefined;
      condition: unknown;
      limit: number;
    }> = [];
    let idPage = 0;
    const database = {
      selectDistinct: (selection: unknown) => ({
        from: () => ({
          where: () => ({
            union: () => ({ as: () => ({ contactId: selection && {} }) }),
          }),
        }),
      }),
      select: (selection?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table === sideEffectIntent) {
              return { orderBy: () => ({ limit: () => [] }) };
            }
            if (table === contactEvent) {
              return {
                orderBy: () => ({
                  limit: (limit: number) => {
                    eventQueries.push({ selection, condition, limit });
                    return eventPages[eventQueries.length - 1] ?? [];
                  },
                }),
              };
            }
            if (table === contact || table === contactState) return [];
            return {
              orderBy: () => ({
                limit: () => {
                  const result = idPage === 0 ? [{ contactId }] : [];
                  idPage += 1;
                  return result;
                },
              }),
            };
          },
        }),
      }),
    };
    const repository = new DrizzleCaptureMarketingRepository(database);

    const pages = [];
    for await (const page of repository.findSkillsWorkflowLearnerFlowRecordPages()) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]?.[0]?.entryEvents).toHaveLength(
      LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE + 2,
    );
    expect(eventQueries).toHaveLength(2);
    expect(
      eventQueries.every(
        ({ limit }) => limit === LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE,
      ),
    ).toBe(true);
    expect(Object.keys(eventQueries[0]?.selection ?? {}).sort()).toEqual([
      "contactId",
      "eventType",
      "id",
      "occurredAt",
      "providerReference",
    ]);
    const secondQuery = new MySqlDialect().sqlToQuery(
      eventQueries[1]?.condition as Parameters<MySqlDialect["sqlToQuery"]>[0],
    );
    expect(secondQuery.sql).toContain("`id` >");
    expect(secondQuery.params).toContain(
      fullPage[LEARNER_FLOW_ENTRY_EVENT_PAGE_SIZE - 1]?.id,
    );
  });

  it("does not classify a learner deleted after the frozen ID scan", async () => {
    let idRead = false;
    const database = {
      selectDistinct: (selection: unknown) => ({
        from: () => ({
          where: () => ({
            union: () => ({ as: () => ({ contactId: selection && {} }) }),
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === sideEffectIntent) {
              return { orderBy: () => ({ limit: () => [] }) };
            }
            if (table === contactEvent) {
              return { orderBy: () => ({ limit: () => [] }) };
            }
            if (table === contact || table === contactState) return [];
            return {
              orderBy: () => ({
                limit: () => {
                  if (idRead) return [];
                  idRead = true;
                  return [{ contactId: "deleted-after-id-scan" }];
                },
              }),
            };
          },
        }),
      }),
    };
    const repository = new DrizzleCaptureMarketingRepository(database);

    const pages = [];
    for await (const page of repository.findSkillsWorkflowLearnerFlowRecordPages()) {
      pages.push(page);
    }

    expect(pages).toEqual([[]]);
    expect(pages.flat()).toHaveLength(0);
  });
});
