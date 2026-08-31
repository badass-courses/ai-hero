import { Context, type Effect } from "effect";

import type { EmailCourseDefinition } from "./definition";
import type {
  AutomationControl,
  CommunicationDecision,
  DeliverableCourseEmailIntent,
  DeliveryOutcome,
  EmailCourseDecision,
  EmailCoursePlanningState,
  EmailCourseStimulus,
  EmailCourseView,
  ScheduleEvidence,
} from "./domain";
import type {
  ContactId,
  CourseId,
  CourseIntentClaimId,
  CourseRunId,
  IsoInstant,
  StimulusId,
} from "./primitives";

export type EmailCourseCommandError =
  | { readonly type: "CourseDefinitionNotFound"; readonly courseId: CourseId }
  | { readonly type: "CourseRunNotFound"; readonly runId: CourseRunId }
  | { readonly type: "CourseRunDecodeFailure"; readonly reason: string }
  | { readonly type: "CourseRunVersionConflict"; readonly runId: CourseRunId }
  | {
      readonly type: "CourseRunConstraintViolation";
      readonly runId: CourseRunId;
      readonly reason: string;
    }
  | { readonly type: "CoursePersistenceUnavailable"; readonly reason: string }
  | { readonly type: "CourseDecisionFailure"; readonly reason: string }
  | { readonly type: "CourseScheduleFailure"; readonly reason: string };

export type EmailCourseDeliveryError =
  | { readonly type: "CourseAutomationStopped"; readonly reason: string }
  | {
      readonly type: "CourseDeliveryTransientUnavailable";
      readonly reason: string;
    }
  | { readonly type: "CourseDeliveryPermanentRefusal"; readonly reason: string }
  | { readonly type: "CourseDeliveryAmbiguous"; readonly reason: string }
  | { readonly type: "CourseDeliveryTargetMissing"; readonly reason: string }
  | { readonly type: "CoursePersistenceUnavailable"; readonly reason: string };

export type EmailCourseInspectionError =
  | { readonly type: "CourseRunNotFound"; readonly runId: CourseRunId }
  | { readonly type: "CourseRunDecodeFailure"; readonly reason: string }
  | { readonly type: "CourseInspectionUnavailable"; readonly reason: string };

export type AdvanceEmailCourseCommand = {
  readonly stimulus: EmailCourseStimulus;
};

export type AdvanceEmailCourseResult = {
  readonly decision: EmailCourseDecision;
  readonly committed: boolean;
  readonly replayedStimulus: boolean;
};

export type DeliverDueCourseEmailsCommand = {
  readonly limit: number;
  readonly now?: IsoInstant;
};

export type DeliveryBatchResult = {
  readonly inspected: number;
  readonly applied: number;
  readonly retried: number;
  readonly refused: number;
  readonly ambiguous: number;
  readonly communicationStopped: number;
};

export type InspectEmailCourseQuery =
  | { readonly type: "Run"; readonly runId: CourseRunId }
  | {
      readonly type: "Queue";
      readonly courseId: CourseId;
      readonly limit: number;
    };

export type EmailCourseRunInspection = {
  readonly type: "Run";
  readonly view: EmailCourseView;
};

export type EmailCourseQueueInspection = {
  readonly type: "Queue";
  readonly pending: number;
  readonly retryWaiting: number;
  readonly held: number;
  readonly oldestDueAt: IsoInstant | null;
};

export type EmailCourseInspection =
  | EmailCourseRunInspection
  | EmailCourseQueueInspection;

export type EmailCourseCommit = {
  readonly stimulus: EmailCourseStimulus;
  readonly expectedVersion: number | null;
  readonly previous: EmailCoursePlanningState | null;
  readonly definition: EmailCourseDefinition;
  readonly automationControl: AutomationControl;
  readonly communication: CommunicationDecision;
  readonly decidedAt: IsoInstant;
  readonly decision: Extract<EmailCourseDecision, { type: "Accepted" }>;
};

export type ClaimedCourseEmailIntent = {
  readonly claimId: CourseIntentClaimId;
  readonly intent: DeliverableCourseEmailIntent;
  readonly claimedAt: IsoInstant;
  readonly claimExpiresAt: IsoInstant;
};

export type AuthorizedCourseDelivery = {
  readonly claim: ClaimedCourseEmailIntent;
  readonly automationControl: Extract<AutomationControl, { type: "Enabled" }>;
  readonly communication: Extract<CommunicationDecision, { type: "Allow" }>;
  readonly checkedAt: IsoInstant;
};

export type CourseScheduleDecision = {
  readonly availableAt: IsoInstant;
  readonly policy:
    | "EighteenHourFloorThenLocalNine"
    | "ExplicitTwentyFourHourFallback";
};

export interface EmailCourseLedger {
  readonly load: (
    runId: CourseRunId,
  ) => Effect.Effect<EmailCoursePlanningState | null, EmailCourseCommandError>;
  readonly findCommittedStimulus: (
    stimulusId: StimulusId,
  ) => Effect.Effect<AdvanceEmailCourseResult | null, EmailCourseCommandError>;
  readonly commit: (
    commit: EmailCourseCommit,
  ) => Effect.Effect<AdvanceEmailCourseResult, EmailCourseCommandError>;
  readonly inspectRun: (
    runId: CourseRunId,
  ) => Effect.Effect<EmailCourseRunInspection, EmailCourseInspectionError>;
}

export const EmailCourseLedger = Context.GenericTag<EmailCourseLedger>(
  "@ai-hero/email-course/EmailCourseLedger",
);

export interface EmailCourseOutbox {
  readonly claimDue: (args: {
    readonly now: IsoInstant;
    readonly limit: number;
  }) => Effect.Effect<
    readonly ClaimedCourseEmailIntent[],
    EmailCourseCommandError
  >;
  readonly inspectQueue: (args: {
    readonly courseId: CourseId;
    readonly limit: number;
  }) => Effect.Effect<EmailCourseQueueInspection, EmailCourseInspectionError>;
}

export const EmailCourseOutbox = Context.GenericTag<EmailCourseOutbox>(
  "@ai-hero/email-course/EmailCourseOutbox",
);

export interface EmailCourseDefinitionRegistry {
  readonly get: (
    courseId: CourseId,
  ) => Effect.Effect<EmailCourseDefinition, EmailCourseCommandError>;
}

export const EmailCourseDefinitionRegistry =
  Context.GenericTag<EmailCourseDefinitionRegistry>(
    "@ai-hero/email-course/EmailCourseDefinitionRegistry",
  );

export interface EmailCourseClock {
  readonly now: Effect.Effect<IsoInstant>;
}

export const EmailCourseClock = Context.GenericTag<EmailCourseClock>(
  "@ai-hero/email-course/EmailCourseClock",
);

export interface EmailCourseScheduler {
  readonly nextAvailableAt: (args: {
    readonly settledAt: IsoInstant;
    readonly scheduleEvidence: ScheduleEvidence;
  }) => Effect.Effect<CourseScheduleDecision, EmailCourseCommandError>;
}

export const EmailCourseScheduler = Context.GenericTag<EmailCourseScheduler>(
  "@ai-hero/email-course/EmailCourseScheduler",
);

export interface EmailCourseAutomationControlRepository {
  readonly readEffective: (
    courseId: CourseId,
  ) => Effect.Effect<AutomationControl, EmailCourseCommandError>;
}

export const EmailCourseAutomationControlRepository =
  Context.GenericTag<EmailCourseAutomationControlRepository>(
    "@ai-hero/email-course/EmailCourseAutomationControlRepository",
  );

export interface CommunicationSafetyPolicy {
  readonly decide: (
    contactId: ContactId,
  ) => Effect.Effect<CommunicationDecision, EmailCourseCommandError>;
}

export const CommunicationSafetyPolicy =
  Context.GenericTag<CommunicationSafetyPolicy>(
    "@ai-hero/email-course/CommunicationSafetyPolicy",
  );

export interface CourseDeliveryPort {
  readonly apply: (
    delivery: AuthorizedCourseDelivery,
  ) => Effect.Effect<
    Extract<DeliveryOutcome, { type: "Applied" }>,
    EmailCourseDeliveryError
  >;
}

export const CourseDeliveryPort = Context.GenericTag<CourseDeliveryPort>(
  "@ai-hero/email-course/CourseDeliveryPort",
);

export interface EmailCourseService {
  readonly advance: (
    command: AdvanceEmailCourseCommand,
  ) => Effect.Effect<AdvanceEmailCourseResult, EmailCourseCommandError>;
  readonly deliverDue: (
    command: DeliverDueCourseEmailsCommand,
  ) => Effect.Effect<DeliveryBatchResult, EmailCourseDeliveryError>;
  readonly inspect: {
    (
      query: Extract<InspectEmailCourseQuery, { type: "Run" }>,
    ): Effect.Effect<EmailCourseRunInspection, EmailCourseInspectionError>;
    (
      query: Extract<InspectEmailCourseQuery, { type: "Queue" }>,
    ): Effect.Effect<EmailCourseQueueInspection, EmailCourseInspectionError>;
  };
}

export const EmailCourseService = Context.GenericTag<EmailCourseService>(
  "@ai-hero/email-course/EmailCourseService",
);
