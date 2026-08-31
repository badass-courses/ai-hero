/* oxlint-disable anti-slop/no-unknown-parameters -- Every unknown here is persisted JSON decoded immediately by a named Zod schema. */
import { z } from "zod";

import type { EmailCourseDefinition } from "./definition";
import {
  EMAIL_COURSE_ACTIVE_SLOT,
  EMAIL_COURSE_SCHEMA_VERSION,
  type ActiveEmailCourseRun,
  type AutomationControl,
  type CommunicationDecision,
  type CourseEmailIntent,
  type EmailCourseDecision,
  type EmailCourseRun,
  type EmailCourseView,
} from "./domain";
import {
  courseIntentKey,
  deriveCourseRunId,
  parseContactId,
  parseContentResourceId,
  parseCourseId,
  parseCourseIntentKey,
  parseCoursePathId,
  parseCourseRunId,
  parseCourseStepId,
  parseDeliveryTargetId,
  parseEventId,
  parseIanaTimeZone,
  parseIntentId,
  parseIsoInstant,
  type CourseStepId,
  type ParseResult,
} from "./primitives";

export type EmailCourseRestorationError = {
  readonly type: "CourseRunDecodeFailure";
  readonly reason: string;
};

export type EmailCourseRestorationResult =
  | { readonly ok: true; readonly value: EmailCourseRun }
  | { readonly ok: false; readonly error: EmailCourseRestorationError };

export type CourseEmailIntentRestorationResult =
  | { readonly ok: true; readonly value: CourseEmailIntent }
  | { readonly ok: false; readonly error: EmailCourseRestorationError };

export type EmailCourseViewRestorationResult =
  | { readonly ok: true; readonly value: EmailCourseView }
  | { readonly ok: false; readonly error: EmailCourseRestorationError };

export type EmailCourseDecisionRestorationResult =
  | { readonly ok: true; readonly value: EmailCourseDecision }
  | { readonly ok: false; readonly error: EmailCourseRestorationError };

const ContactIdSchema = parsedString(parseContactId);
const ContentResourceIdSchema = parsedString(parseContentResourceId);
const CourseIdSchema = parsedString(parseCourseId);
const CourseIntentKeySchema = parsedString(parseCourseIntentKey);
const CoursePathIdSchema = parsedString(parseCoursePathId);
const CourseRunIdSchema = parsedString(parseCourseRunId);
const CourseStepIdSchema = parsedString(parseCourseStepId);
const DeliveryTargetIdSchema = parsedString(parseDeliveryTargetId);
const EventIdSchema = parsedString(parseEventId);
const IntentIdSchema = parsedString(parseIntentId);
const IsoInstantSchema = parsedString(parseIsoInstant);
const IanaTimeZoneSchema = parsedString(parseIanaTimeZone);
const NonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);

const CommunicationStopReasonSchema = z.enum([
  "Unsubscribed",
  "Suppressed",
  "Bounced",
  "Complained",
  "IdentityConflict",
  "OperatorStop",
]);

const ScheduleEvidenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("BrowserEntryHeader"),
    headerName: z.literal("x-vercel-ip-timezone"),
    timeZone: IanaTimeZoneSchema,
    capturedAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("ExplicitFallback"),
    reason: z.enum(["header-missing", "header-invalid", "legacy-entry"]),
    timeZone: z.literal("America/Los_Angeles"),
    capturedAt: IsoInstantSchema,
  }),
]);

const AppliedOutcomeSchema = z.object({
  type: z.literal("Applied"),
  deliveryReceiptId: NonBlank,
  appliedAt: IsoInstantSchema,
});
const PermanentRefusalOutcomeSchema = z.object({
  type: z.literal("PermanentRefusal"),
  reason: NonBlank,
  refusedAt: IsoInstantSchema,
});
const CommunicationStoppedOutcomeSchema = z.object({
  type: z.literal("CommunicationStopped"),
  reason: CommunicationStopReasonSchema,
  stoppedAt: IsoInstantSchema,
});
const TransientFailureOutcomeSchema = z.object({
  type: z.literal("TransientFailure"),
  reason: NonBlank,
  failedAt: IsoInstantSchema,
});
const AmbiguousOutcomeSchema = z.object({
  type: z.literal("Ambiguous"),
  reason: NonBlank,
  observedAt: IsoInstantSchema,
});
const DeliveryOutcomeSchema = z.discriminatedUnion("type", [
  AppliedOutcomeSchema,
  TransientFailureOutcomeSchema,
  PermanentRefusalOutcomeSchema,
  AmbiguousOutcomeSchema,
  CommunicationStoppedOutcomeSchema,
]);

const IntentIdentitySchema = {
  id: IntentIdSchema,
  idempotencyKey: CourseIntentKeySchema,
  contactId: ContactIdSchema,
  runId: CourseRunIdSchema,
  stepId: CourseStepIdSchema,
  pathId: CoursePathIdSchema,
  contentResourceId: ContentResourceIdSchema,
  deliveryTargetId: DeliveryTargetIdSchema,
};

const PendingIntentSchema = z.object({
  status: z.literal("Pending"),
  ...IntentIdentitySchema,
  availableAt: IsoInstantSchema,
  activeSlot: z.literal(EMAIL_COURSE_ACTIVE_SLOT),
  attempt: z.number().int().nonnegative(),
});
const RetryWaitingIntentSchema = z.object({
  status: z.literal("RetryWaiting"),
  ...IntentIdentitySchema,
  availableAt: IsoInstantSchema,
  activeSlot: z.literal(EMAIL_COURSE_ACTIVE_SLOT),
  attempt: z.number().int().nonnegative(),
  lastFailure: NonBlank,
});
const HeldIntentSchema = z.object({
  status: z.literal("Held"),
  ...IntentIdentitySchema,
  availableAt: IsoInstantSchema,
  activeSlot: z.literal(EMAIL_COURSE_ACTIVE_SLOT),
  attempt: z.number().int().nonnegative(),
  reason: z.enum([
    "AmbiguousDeliveryOutcome",
    "AutomationStopped",
    "CommunicationStopped",
  ]),
});
const SettledIntentSchema = z.object({
  status: z.literal("Settled"),
  ...IntentIdentitySchema,
  settledAt: IsoInstantSchema,
  outcome: z.discriminatedUnion("type", [
    AppliedOutcomeSchema,
    PermanentRefusalOutcomeSchema,
    CommunicationStoppedOutcomeSchema,
  ]),
  activeSlot: z.null(),
});
const CourseEmailIntentSchema = z.discriminatedUnion("status", [
  PendingIntentSchema,
  RetryWaitingIntentSchema,
  HeldIntentSchema,
  SettledIntentSchema,
]);

const RunBaseSchema = {
  schemaVersion: z.literal(EMAIL_COURSE_SCHEMA_VERSION),
  runId: CourseRunIdSchema,
  contactId: ContactIdSchema,
  courseId: CourseIdSchema,
  definitionVersion: NonBlank,
  entryEventId: EventIdSchema,
  scheduleEvidence: ScheduleEvidenceSchema,
  actorVersion: z.number().int().nonnegative(),
  startedAt: IsoInstantSchema,
};

const ActiveRunSchema = <Phase extends ActiveEmailCourseRun["phase"]>(
  phase: Phase,
) =>
  z.object({
    ...RunBaseSchema,
    phase: z.literal(phase),
    activeIntentId: IntentIdSchema,
  });

const CourseStopReasonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("AutomationStopped"),
    reason: NonBlank,
  }),
  z.object({
    type: z.literal("CommunicationStopped"),
    reason: CommunicationStopReasonSchema,
  }),
  z.object({
    type: z.literal("PermanentDeliveryRefusal"),
    reason: NonBlank,
  }),
]);

const EmailCourseRunSchema = z.discriminatedUnion("phase", [
  ActiveRunSchema("active.awaitingDelivery"),
  ActiveRunSchema("active.awaitingNextDue"),
  ActiveRunSchema("active.retryWait"),
  z.object({
    ...RunBaseSchema,
    phase: z.literal("sequenceExhausted"),
    exhaustionFactId: EventIdSchema,
    exhaustedAt: IsoInstantSchema,
    terminalIntentId: IntentIdSchema,
    terminalStepId: CourseStepIdSchema,
  }),
  z.object({
    ...RunBaseSchema,
    phase: z.literal("stopped"),
    reason: CourseStopReasonSchema,
    stoppedAt: IsoInstantSchema,
  }),
]);

const EmailCourseDomainEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("CourseRunStarted"),
    runId: CourseRunIdSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("AnswerObserved"),
    answerEventId: EventIdSchema,
    selectedPathId: CoursePathIdSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("NextEmailPlanned"),
    intentId: IntentIdSchema,
    stepId: CourseStepIdSchema,
    availableAt: IsoInstantSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("NextEmailAccelerated"),
    intentId: IntentIdSchema,
    answerEventId: EventIdSchema,
    availableAt: IsoInstantSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("NextEmailRouteChanged"),
    intentId: IntentIdSchema,
    fromStepId: CourseStepIdSchema,
    toStepId: CourseStepIdSchema,
    answerEventId: EventIdSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("DeliveryRecorded"),
    intentId: IntentIdSchema,
    outcome: DeliveryOutcomeSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("CourseSequenceExhausted"),
    factId: EventIdSchema,
    terminalIntentId: IntentIdSchema,
    terminalStepId: CourseStepIdSchema,
    occurredAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("CourseRunStopped"),
    reason: CourseStopReasonSchema,
    occurredAt: IsoInstantSchema,
  }),
]);

const EmailCourseOutboxChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Plan"), intent: PendingIntentSchema }),
  z.object({ type: z.literal("Accelerate"), intent: PendingIntentSchema }),
  z.object({
    type: z.literal("ReplaceRoute"),
    expectedIntentId: IntentIdSchema,
    replacement: PendingIntentSchema,
  }),
  z.object({ type: z.literal("Settle"), intent: SettledIntentSchema }),
  z.object({
    type: z.literal("ScheduleRetry"),
    intent: RetryWaitingIntentSchema,
  }),
  z.object({ type: z.literal("Hold"), intent: HeldIntentSchema }),
]);

const EmailCourseDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("Accepted"),
    next: EmailCourseRunSchema,
    events: z.array(EmailCourseDomainEventSchema),
    outboxChanges: z.array(EmailCourseOutboxChangeSchema),
  }),
  z.object({
    type: z.literal("Ignored"),
    reason: z.enum(["DuplicateStimulus", "LateAnswer"]),
  }),
]);

const PersistedAutomationControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("Enabled"),
    version: NonBlank,
    enabledAt: IsoInstantSchema,
  }),
  z.object({
    type: z.literal("Stopped"),
    version: NonBlank,
    reason: NonBlank,
    stoppedAt: IsoInstantSchema,
  }),
]);

const CommunicationDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Allow") }),
  z.object({
    type: z.literal("Stop"),
    reason: CommunicationStopReasonSchema,
  }),
]);

export function restoreEmailCourseRun(
  input: unknown,
  definition: EmailCourseDefinition,
): EmailCourseRestorationResult {
  const restored = EmailCourseRunSchema.safeParse(input);
  if (!restored.success) {
    return decodeFailure(restored.error.issues[0]?.message ?? "Invalid run");
  }
  const run = restored.data;
  if (
    run.courseId !== definition.courseId ||
    run.definitionVersion !== definition.version
  ) {
    return decodeFailure("Run does not match the course definition");
  }
  if (
    run.runId !==
    deriveCourseRunId({
      courseId: run.courseId,
      entryEventId: run.entryEventId,
    })
  ) {
    return decodeFailure("Run identity does not match its course entry");
  }
  if (run.phase === "sequenceExhausted") {
    const terminalStep = findStep(definition, run.terminalStepId);
    if (!terminalStep || terminalStep.defaultNextStepId !== null) {
      return decodeFailure(
        "Sequence exhaustion does not reference a terminal step",
      );
    }
  }
  return { ok: true, value: run };
}

export function restoreCourseEmailIntent(
  input: unknown,
  definition: EmailCourseDefinition,
): CourseEmailIntentRestorationResult {
  const restored = CourseEmailIntentSchema.safeParse(input);
  if (!restored.success) {
    return decodeFailure(restored.error.issues[0]?.message ?? "Invalid intent");
  }
  const intent = restored.data;
  const expectedKey = courseIntentKey({
    contactId: intent.contactId,
    pathId: intent.pathId,
    contentResourceId: intent.contentResourceId,
  });
  if (intent.idempotencyKey !== expectedKey) {
    return decodeFailure("Intent idempotency key does not match its identity");
  }
  const step = findStep(definition, intent.stepId);
  if (
    !step ||
    step.pathId !== intent.pathId ||
    step.contentResourceId !== intent.contentResourceId ||
    step.deliveryTargetId !== intent.deliveryTargetId
  ) {
    return decodeFailure("Intent does not match the course definition");
  }
  return { ok: true, value: intent };
}

export function restoreEmailCourseDecision(
  input: unknown,
  definition: EmailCourseDefinition,
): EmailCourseDecisionRestorationResult {
  const restored = EmailCourseDecisionSchema.safeParse(input);
  if (!restored.success) {
    return decodeFailure(
      restored.error.issues[0]?.message ?? "Invalid course decision",
    );
  }
  if (restored.data.type === "Ignored") {
    return { ok: true, value: restored.data };
  }
  const restoredRun = restoreEmailCourseRun(restored.data.next, definition);
  if (!restoredRun.ok) return restoredRun;
  for (const change of restored.data.outboxChanges) {
    const intent =
      change.type === "ReplaceRoute" ? change.replacement : change.intent;
    const restoredIntent = restoreCourseEmailIntent(intent, definition);
    if (!restoredIntent.ok) return restoredIntent;
  }
  return {
    ok: true,
    value: { ...restored.data, next: restoredRun.value },
  };
}

export function restoreAutomationControl(
  input: unknown,
):
  | { readonly ok: true; readonly value: AutomationControl }
  | { readonly ok: false; readonly error: EmailCourseRestorationError } {
  if (input === null || input === undefined) {
    return {
      ok: true,
      value: {
        type: "Stopped",
        source: "Missing",
        version: null,
        reason: "MissingControl",
        stoppedAt: null,
      },
    };
  }
  const restored = PersistedAutomationControlSchema.safeParse(input);
  if (!restored.success) {
    return decodeFailure(
      restored.error.issues[0]?.message ?? "Invalid control",
    );
  }
  return restored.data.type === "Enabled"
    ? { ok: true, value: restored.data }
    : {
        ok: true,
        value: { ...restored.data, source: "Persisted" },
      };
}

export function restoreCommunicationDecision(
  input: unknown,
):
  | { readonly ok: true; readonly value: CommunicationDecision }
  | { readonly ok: false; readonly error: EmailCourseRestorationError } {
  const restored = CommunicationDecisionSchema.safeParse(input);
  return restored.success
    ? { ok: true, value: restored.data }
    : decodeFailure(restored.error.issues[0]?.message ?? "Invalid decision");
}

export function restoreEmailCourseView(
  input: {
    readonly run: unknown;
    readonly currentIntent: unknown | null;
    readonly communication: unknown;
    readonly automationControl: unknown;
  },
  definition: EmailCourseDefinition,
): EmailCourseViewRestorationResult {
  const restoredRun = restoreEmailCourseRun(input.run, definition);
  if (!restoredRun.ok) return restoredRun;
  const restoredIntent =
    input.currentIntent === null
      ? ({ ok: true, value: null } as const)
      : restoreCourseEmailIntent(input.currentIntent, definition);
  if (!restoredIntent.ok) return restoredIntent;
  const restoredCommunication = restoreCommunicationDecision(
    input.communication,
  );
  if (!restoredCommunication.ok) return restoredCommunication;
  const restoredControl = restoreAutomationControl(input.automationControl);
  if (!restoredControl.ok) return restoredControl;

  const run = restoredRun.value;
  const currentIntent = restoredIntent.value;
  const context = {
    communication: restoredCommunication.value,
    automationControl: restoredControl.value,
  };
  if (run.phase === "active.awaitingDelivery") {
    if (
      !currentIntent ||
      !intentBelongsToRun(currentIntent, run) ||
      currentIntent.id !== run.activeIntentId ||
      (currentIntent.status !== "Pending" && currentIntent.status !== "Held")
    ) {
      return decodeFailure("Awaiting-delivery run has an incompatible intent");
    }
    return { ok: true, value: { ...context, run, currentIntent } };
  }
  if (run.phase === "active.awaitingNextDue") {
    if (
      !currentIntent ||
      !intentBelongsToRun(currentIntent, run) ||
      currentIntent.id !== run.activeIntentId ||
      currentIntent.status !== "Pending"
    ) {
      return decodeFailure("Awaiting-next-due run has an incompatible intent");
    }
    return { ok: true, value: { ...context, run, currentIntent } };
  }
  if (run.phase === "active.retryWait") {
    if (
      !currentIntent ||
      !intentBelongsToRun(currentIntent, run) ||
      currentIntent.id !== run.activeIntentId ||
      currentIntent.status !== "RetryWaiting"
    ) {
      return decodeFailure("Retry-wait run has an incompatible intent");
    }
    return { ok: true, value: { ...context, run, currentIntent } };
  }
  if (run.phase === "sequenceExhausted") {
    if (
      !currentIntent ||
      !intentBelongsToRun(currentIntent, run) ||
      currentIntent.id !== run.terminalIntentId ||
      currentIntent.stepId !== run.terminalStepId
    ) {
      return decodeFailure("Sequence-exhausted run has an incompatible intent");
    }
    return { ok: true, value: { ...context, run, currentIntent } };
  }
  if (
    currentIntent &&
    (!intentBelongsToRun(currentIntent, run) ||
      (currentIntent.status !== "Held" && currentIntent.status !== "Settled"))
  ) {
    return decodeFailure("Stopped run has an incompatible intent");
  }
  if (
    run.reason.type === "CommunicationStopped" &&
    (context.communication.type !== "Stop" ||
      context.communication.reason !== run.reason.reason)
  ) {
    return decodeFailure("Stopped run conflicts with communication safety");
  }
  if (
    run.reason.type === "AutomationStopped" &&
    (context.automationControl.type !== "Stopped" ||
      context.automationControl.reason !== run.reason.reason)
  ) {
    return decodeFailure("Stopped run conflicts with automation control");
  }
  return { ok: true, value: { ...context, run, currentIntent } };
}

function intentBelongsToRun(
  intent: CourseEmailIntent,
  run: EmailCourseRun,
): boolean {
  return intent.runId === run.runId && intent.contactId === run.contactId;
}

function findStep(definition: EmailCourseDefinition, stepId: CourseStepId) {
  for (const path of definition.paths) {
    const step = path.steps.find((candidate) => candidate.stepId === stepId);
    if (step) return step;
  }
  return null;
}

function parsedString<Value extends string>(
  parser: (value: string) => ParseResult<Value>,
) {
  return z.string().transform((input, context): Value => {
    const parsed = parser(input);
    if (parsed.ok && parsed.value === input) return parsed.value;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Value failed domain parsing",
    });
    return z.NEVER;
  });
}

function decodeFailure(
  reason: string,
): Extract<EmailCourseRestorationResult, { readonly ok: false }> {
  return { ok: false, error: { type: "CourseRunDecodeFailure", reason } };
}
