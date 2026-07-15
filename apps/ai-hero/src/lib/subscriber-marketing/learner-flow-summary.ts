import { db } from "@/db";

import {
  DrizzleCaptureMarketingRepository,
  type LearnerFlowRecord,
} from "./drizzle-capture-repository";
import {
  classifyLearnerFlowContact,
  type LearnerFlowClassification,
  type LearnerFlowStuckCause,
} from "./learner-flow-classifier";

export type LearnerFlowSummaryItem = {
  contactId: string;
  classification: LearnerFlowClassification;
};

export type LearnerFlowAggregateSummary = {
  generatedAt: string;
  counts: {
    total: number;
    moving: number;
    terminal: number;
    stuck: number;
    accounted: number;
  };
  causeCounts: Partial<Record<LearnerFlowStuckCause, number>>;
  assertion: {
    passed: boolean;
    expression: string;
  };
};

export function summarizeLearnerFlowRecords(args: {
  records: LearnerFlowRecord[];
  now: string;
}): {
  learners: LearnerFlowSummaryItem[];
  summary: LearnerFlowAggregateSummary;
} {
  const learners = args.records.map((record) => ({
    contactId: record.contactId,
    classification: classifyLearnerFlowContact({
      contactId: record.contactId,
      contact: record.contact,
      contactState: record.contactState,
      intents: record.intents,
      entryEvents: record.entryEvents,
      now: args.now,
    }),
  }));
  const counts = {
    total: learners.length,
    moving: learners.filter(
      ({ classification }) => classification.state === "moving",
    ).length,
    terminal: learners.filter(
      ({ classification }) => classification.state === "terminal",
    ).length,
    stuck: learners.filter(
      ({ classification }) => classification.state === "stuck",
    ).length,
    accounted: learners.length,
  };
  const causeCounts = learners.reduce<
    Partial<Record<LearnerFlowStuckCause, number>>
  >((current, { classification }) => {
    if (classification.cause) {
      current[classification.cause] = (current[classification.cause] ?? 0) + 1;
    }
    return current;
  }, {});

  return {
    learners,
    summary: {
      generatedAt: args.now,
      counts,
      causeCounts,
      assertion: {
        passed: counts.moving + counts.terminal + counts.stuck === counts.total,
        expression:
          "moving + terminal + stuck = total contacts on course paths",
      },
    },
  };
}

/** Aggregate-only, authenticated-admin reporting surface. */
export async function getLearnerFlowAggregateSummary() {
  const repository = new DrizzleCaptureMarketingRepository(db);
  const generatedAt = new Date().toISOString();
  const records = await repository.findSkillsWorkflowLearnerFlowRecords();
  return summarizeLearnerFlowRecords({ records, now: generatedAt }).summary;
}
