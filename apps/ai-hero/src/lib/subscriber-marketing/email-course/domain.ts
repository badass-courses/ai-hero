import type {
  ContactId,
  ContentResourceId,
  CourseId,
  CourseIntentKey,
  CoursePathId,
  CourseRunId,
  CourseStepId,
  DeliveryTargetId,
  EventId,
  IanaTimeZone,
  IntentId,
  IsoInstant,
  StimulusId,
} from "./primitives";

export const EMAIL_COURSE_SCHEMA_VERSION = 1 as const;
export const EMAIL_COURSE_ACTIVE_SLOT = "next" as const;

export type ScheduleEvidence =
  | {
      readonly type: "BrowserEntryHeader";
      readonly headerName: "x-vercel-ip-timezone";
      readonly timeZone: IanaTimeZone;
      readonly capturedAt: IsoInstant;
    }
  | {
      readonly type: "ExplicitFallback";
      readonly reason: "header-missing" | "header-invalid" | "legacy-entry";
      readonly timeZone: "America/Los_Angeles";
      readonly capturedAt: IsoInstant;
    };

export type CommunicationStopReason =
  | "Unsubscribed"
  | "Suppressed"
  | "Bounced"
  | "Complained"
  | "IdentityConflict"
  | "OperatorStop";

export type CommunicationDecision =
  | { readonly type: "Allow" }
  | { readonly type: "Stop"; readonly reason: CommunicationStopReason };

export type AutomationControl =
  | {
      readonly type: "Enabled";
      readonly version: string;
      readonly enabledAt: IsoInstant;
    }
  | {
      readonly type: "Stopped";
      readonly source: "Persisted";
      readonly version: string;
      readonly reason: string;
      readonly stoppedAt: IsoInstant;
    }
  | {
      readonly type: "Stopped";
      readonly source: "Missing";
      readonly version: null;
      readonly reason: "MissingControl";
      readonly stoppedAt: null;
    };

export type DeliveryOutcome =
  | {
      readonly type: "Applied";
      readonly deliveryReceiptId: string;
      readonly appliedAt: IsoInstant;
    }
  | {
      readonly type: "TransientFailure";
      readonly reason: string;
      readonly failedAt: IsoInstant;
    }
  | {
      readonly type: "PermanentRefusal";
      readonly reason: string;
      readonly refusedAt: IsoInstant;
    }
  | {
      readonly type: "Ambiguous";
      readonly reason: string;
      readonly observedAt: IsoInstant;
    }
  | {
      readonly type: "CommunicationStopped";
      readonly reason: CommunicationStopReason;
      readonly stoppedAt: IsoInstant;
    };

export type EmailCourseStimulus =
  | {
      readonly type: "ExplicitSignup";
      readonly stimulusId: StimulusId;
      readonly contactId: ContactId;
      readonly courseId: CourseId;
      readonly entryEventId: EventId;
      readonly scheduleEvidence: ScheduleEvidence;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "DeliverySettled";
      readonly stimulusId: StimulusId;
      readonly runId: CourseRunId;
      readonly intentId: IntentId;
      readonly outcome: DeliveryOutcome;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "AnswerSelected";
      readonly stimulusId: StimulusId;
      readonly runId: CourseRunId;
      readonly answerEventId: EventId;
      readonly sentStepId: CourseStepId;
      readonly selectedPathId: CoursePathId;
      readonly selectedNextStepId: CourseStepId | null;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "RepairRequested";
      readonly stimulusId: StimulusId;
      readonly runId: CourseRunId;
      readonly reason:
        | "MissingNextIntent"
        | "LegacyStateImport"
        | "AmbiguousDeliveryOutcome";
      readonly occurredAt: IsoInstant;
    };

export type CourseEmailIntentIdentity = {
  readonly id: IntentId;
  readonly idempotencyKey: CourseIntentKey;
  readonly contactId: ContactId;
  readonly runId: CourseRunId;
  readonly stepId: CourseStepId;
  readonly pathId: CoursePathId;
  readonly contentResourceId: ContentResourceId;
  readonly deliveryTargetId: DeliveryTargetId;
};

export type PendingCourseEmailIntent = CourseEmailIntentIdentity & {
  readonly status: "Pending";
  readonly availableAt: IsoInstant;
  readonly activeSlot: typeof EMAIL_COURSE_ACTIVE_SLOT;
  readonly attempt: number;
};

export type RetryWaitingCourseEmailIntent = CourseEmailIntentIdentity & {
  readonly status: "RetryWaiting";
  readonly availableAt: IsoInstant;
  readonly activeSlot: typeof EMAIL_COURSE_ACTIVE_SLOT;
  readonly attempt: number;
  readonly lastFailure: string;
};

export type HeldCourseEmailIntent = CourseEmailIntentIdentity & {
  readonly status: "Held";
  readonly availableAt: IsoInstant;
  readonly activeSlot: typeof EMAIL_COURSE_ACTIVE_SLOT;
  readonly attempt: number;
  readonly reason: "AmbiguousDeliveryOutcome" | "CommunicationStopped";
};

export type DeliverableCourseEmailIntent =
  | PendingCourseEmailIntent
  | RetryWaitingCourseEmailIntent;

export type ActiveCourseEmailIntent =
  | DeliverableCourseEmailIntent
  | HeldCourseEmailIntent;

export type SettledCourseEmailIntent = CourseEmailIntentIdentity & {
  readonly status: "Settled";
  readonly settledAt: IsoInstant;
  readonly outcome: Extract<
    DeliveryOutcome,
    { type: "Applied" | "PermanentRefusal" | "CommunicationStopped" }
  >;
  readonly activeSlot: null;
};

export type CourseEmailIntent =
  | ActiveCourseEmailIntent
  | SettledCourseEmailIntent;

export type EmailCourseRunBase = {
  readonly schemaVersion: typeof EMAIL_COURSE_SCHEMA_VERSION;
  readonly runId: CourseRunId;
  readonly contactId: ContactId;
  readonly courseId: CourseId;
  readonly definitionVersion: string;
  readonly entryEventId: EventId;
  readonly scheduleEvidence: ScheduleEvidence;
  readonly actorVersion: number;
  readonly startedAt: IsoInstant;
};

export type ActiveEmailCourseRun = EmailCourseRunBase &
  (
    | {
        readonly phase: "active.awaitingDelivery";
        readonly activeIntentId: IntentId;
      }
    | {
        readonly phase: "active.awaitingNextDue";
        readonly activeIntentId: IntentId;
      }
    | {
        readonly phase: "active.retryWait";
        readonly activeIntentId: IntentId;
      }
  );

export type CourseStopReason =
  | {
      readonly type: "CommunicationStopped";
      readonly reason: CommunicationStopReason;
    }
  | {
      readonly type: "PermanentDeliveryRefusal";
      readonly reason: string;
    };

export type FinalEmailCourseRun = EmailCourseRunBase &
  (
    | {
        readonly phase: "sequenceExhausted";
        readonly exhaustionFactId: EventId;
        readonly exhaustedAt: IsoInstant;
        readonly terminalIntentId: IntentId;
        readonly terminalStepId: CourseStepId;
      }
    | {
        readonly phase: "stopped";
        readonly reason: CourseStopReason;
        readonly stoppedAt: IsoInstant;
      }
  );

export type EmailCourseRun = ActiveEmailCourseRun | FinalEmailCourseRun;
export type EmailCoursePhase = EmailCourseRun["phase"];

export type EmailCourseDomainEvent =
  | {
      readonly type: "CourseRunStarted";
      readonly runId: CourseRunId;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "AnswerObserved";
      readonly answerEventId: EventId;
      readonly selectedPathId: CoursePathId;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "NextEmailPlanned";
      readonly intentId: IntentId;
      readonly stepId: CourseStepId;
      readonly availableAt: IsoInstant;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "NextEmailAccelerated";
      readonly intentId: IntentId;
      readonly answerEventId: EventId;
      readonly availableAt: IsoInstant;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "NextEmailRouteChanged";
      readonly intentId: IntentId;
      readonly fromStepId: CourseStepId;
      readonly toStepId: CourseStepId;
      readonly answerEventId: EventId;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "DeliveryRecorded";
      readonly intentId: IntentId;
      readonly outcome: DeliveryOutcome;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "CourseSequenceExhausted";
      readonly factId: EventId;
      readonly terminalIntentId: IntentId;
      readonly terminalStepId: CourseStepId;
      readonly occurredAt: IsoInstant;
    }
  | {
      readonly type: "CourseRunStopped";
      readonly reason: CourseStopReason;
      readonly occurredAt: IsoInstant;
    };

export type EmailCourseOutboxChange =
  | {
      readonly type: "Plan";
      readonly intent: PendingCourseEmailIntent;
    }
  | {
      readonly type: "Accelerate";
      readonly intentId: IntentId;
      readonly availableAt: IsoInstant;
    }
  | {
      readonly type: "ReplaceRoute";
      readonly expectedIntentId: IntentId;
      readonly replacement: PendingCourseEmailIntent;
    }
  | {
      readonly type: "Settle";
      readonly intentId: IntentId;
      readonly outcome: Extract<
        DeliveryOutcome,
        { type: "Applied" | "PermanentRefusal" | "CommunicationStopped" }
      >;
      readonly settledAt: IsoInstant;
    }
  | {
      readonly type: "ScheduleRetry";
      readonly intentId: IntentId;
      readonly availableAt: IsoInstant;
      readonly reason: string;
    }
  | {
      readonly type: "Hold";
      readonly intentId: IntentId;
      readonly reason: HeldCourseEmailIntent["reason"];
    };

export type EmailCourseDecision =
  | {
      readonly type: "Accepted";
      readonly next: EmailCourseRun;
      readonly events: readonly EmailCourseDomainEvent[];
      readonly outboxChanges: readonly EmailCourseOutboxChange[];
    }
  | {
      readonly type: "Ignored";
      readonly reason: "DuplicateStimulus" | "LateAnswer";
    };

type EmailCourseViewContext = {
  readonly communication: CommunicationDecision;
  readonly automationControl: AutomationControl;
};

export type EmailCourseView = EmailCourseViewContext &
  (
    | {
        readonly run: Extract<
          ActiveEmailCourseRun,
          { phase: "active.awaitingDelivery" }
        >;
        readonly currentIntent:
          | PendingCourseEmailIntent
          | HeldCourseEmailIntent;
      }
    | {
        readonly run: Extract<
          ActiveEmailCourseRun,
          { phase: "active.awaitingNextDue" }
        >;
        readonly currentIntent: PendingCourseEmailIntent;
      }
    | {
        readonly run: Extract<
          ActiveEmailCourseRun,
          { phase: "active.retryWait" }
        >;
        readonly currentIntent: RetryWaitingCourseEmailIntent;
      }
    | {
        readonly run: Extract<
          FinalEmailCourseRun,
          { phase: "sequenceExhausted" }
        >;
        readonly currentIntent: CourseEmailIntent;
      }
    | {
        readonly run: Extract<FinalEmailCourseRun, { phase: "stopped" }>;
        readonly currentIntent:
          | HeldCourseEmailIntent
          | SettledCourseEmailIntent
          | null;
      }
  );
