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

type SummaryAccumulator = Omit<
  LearnerFlowAggregateSummary,
  "generatedAt" | "assertion"
>;

function emptyAccumulator(): SummaryAccumulator {
  return {
    counts: { total: 0, moving: 0, terminal: 0, stuck: 0, accounted: 0 },
    causeCounts: {},
  };
}

function addLearnerFlowRecords(
  accumulator: SummaryAccumulator,
  records: LearnerFlowRecord[],
  now: string,
) {
  const learners = records.map((record) => ({
    contactId: record.contactId,
    classification: classifyLearnerFlowContact({
      contactId: record.contactId,
      contact: record.contact,
      contactState: record.contactState,
      intents: record.intents,
      entryEvents: record.entryEvents,
      now,
    }),
  }));
  for (const { classification } of learners) {
    accumulator.counts.total += 1;
    accumulator.counts[classification.state] += 1;
    accumulator.counts.accounted += 1;
    if (classification.cause) {
      accumulator.causeCounts[classification.cause] =
        (accumulator.causeCounts[classification.cause] ?? 0) + 1;
    }
  }
  return learners;
}

function finishLearnerFlowSummary(
  accumulator: SummaryAccumulator,
  generatedAt: string,
): LearnerFlowAggregateSummary {
  return {
    generatedAt,
    ...accumulator,
    assertion: {
      passed:
        accumulator.counts.moving +
          accumulator.counts.terminal +
          accumulator.counts.stuck ===
        accumulator.counts.total,
      expression:
        "moving + terminal + stuck = total contacts on course paths",
    },
  };
}

export function summarizeLearnerFlowRecords(args: {
  records: LearnerFlowRecord[];
  now: string;
}): {
  learners: LearnerFlowSummaryItem[];
  summary: LearnerFlowAggregateSummary;
} {
  const accumulator = emptyAccumulator();
  const learners = addLearnerFlowRecords(
    accumulator,
    args.records,
    args.now,
  );
  return {
    learners,
    summary: finishLearnerFlowSummary(accumulator, args.now),
  };
}

export async function summarizeLearnerFlowRecordPages(args: {
  pages: AsyncIterable<LearnerFlowRecord[]>;
  now: string;
}) {
  const accumulator = emptyAccumulator();
  for await (const records of args.pages) {
    addLearnerFlowRecords(accumulator, records, args.now);
  }
  return finishLearnerFlowSummary(accumulator, args.now);
}

/** Pure aggregate read. Callers own logging and process resource cleanup. */
export async function getLearnerFlowAggregateSummary() {
  const repository = new DrizzleCaptureMarketingRepository(db);
  const generatedAt = new Date().toISOString();
  return summarizeLearnerFlowRecordPages({
    pages: repository.findSkillsWorkflowLearnerFlowRecordPages(),
    now: generatedAt,
  });
}
