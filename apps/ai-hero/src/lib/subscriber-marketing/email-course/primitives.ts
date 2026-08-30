declare const emailCourseBrand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [emailCourseBrand]: Name;
};

export type ContactId = Brand<string, "ContactId">;
export type ContentResourceId = Brand<string, "ContentResourceId">;
export type CourseId = Brand<string, "CourseId">;
export type CourseIntentClaimId = Brand<string, "CourseIntentClaimId">;
export type CourseIntentKey = Brand<string, "CourseIntentKey">;
export type CoursePathId = Brand<string, "CoursePathId">;
export type CourseRunId = Brand<string, "CourseRunId">;
export type CourseStepId = Brand<string, "CourseStepId">;
export type DeliveryTargetId = Brand<string, "DeliveryTargetId">;
export type EventId = Brand<string, "EventId">;
export type IntentId = Brand<string, "IntentId">;
export type IanaTimeZone = Brand<string, "IanaTimeZone">;
export type IsoInstant = Brand<string, "IsoInstant">;
export type StimulusId = Brand<string, "StimulusId">;

export type PrimitiveParseError = {
  readonly type: "PrimitiveParseError";
  readonly field: string;
  readonly value: string;
  readonly reason:
    | "blank"
    | "invalid-course-run-id"
    | "invalid-iana-time-zone"
    | "invalid-iso-instant";
};

export type ParseResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: PrimitiveParseError };

function parseNonBlankBrand<Name extends string>(args: {
  field: string;
  value: string;
}): ParseResult<Brand<string, Name>> {
  const value = args.value.trim();
  if (value.length === 0) {
    return {
      ok: false,
      error: {
        type: "PrimitiveParseError",
        field: args.field,
        value: args.value,
        reason: "blank",
      },
    };
  }

  // SAFETY: this parser is the only construction edge for non-blank brands.
  return { ok: true, value: value as Brand<string, Name> };
}

export function parseContactId(value: string) {
  return parseNonBlankBrand<"ContactId">({ field: "contactId", value });
}

export function parseContentResourceId(value: string) {
  return parseNonBlankBrand<"ContentResourceId">({
    field: "contentResourceId",
    value,
  });
}

export function parseCourseId(value: string) {
  return parseNonBlankBrand<"CourseId">({ field: "courseId", value });
}

export function parseCourseIntentClaimId(value: string) {
  return parseNonBlankBrand<"CourseIntentClaimId">({
    field: "courseIntentClaimId",
    value,
  });
}

export function parseCourseIntentKey(value: string) {
  return parseNonBlankBrand<"CourseIntentKey">({
    field: "courseIntentKey",
    value,
  });
}

export function parseCoursePathId(value: string) {
  return parseNonBlankBrand<"CoursePathId">({ field: "coursePathId", value });
}

export function parseCourseRunId(value: string): ParseResult<CourseRunId> {
  const parsed = parseNonBlankBrand<"CourseRunId">({
    field: "courseRunId",
    value,
  });
  if (!parsed.ok) return parsed;
  if (!parsed.value.startsWith("email-course:")) {
    return {
      ok: false,
      error: {
        type: "PrimitiveParseError",
        field: "courseRunId",
        value,
        reason: "invalid-course-run-id",
      },
    };
  }
  return parsed;
}

export function parseCourseStepId(value: string) {
  return parseNonBlankBrand<"CourseStepId">({ field: "courseStepId", value });
}

export function parseDeliveryTargetId(value: string) {
  return parseNonBlankBrand<"DeliveryTargetId">({
    field: "deliveryTargetId",
    value,
  });
}

export function parseEventId(value: string) {
  return parseNonBlankBrand<"EventId">({ field: "eventId", value });
}

export function parseIntentId(value: string) {
  return parseNonBlankBrand<"IntentId">({ field: "intentId", value });
}

export function parseStimulusId(value: string) {
  return parseNonBlankBrand<"StimulusId">({ field: "stimulusId", value });
}

export function parseIsoInstant(value: string): ParseResult<IsoInstant> {
  const candidate = value.trim();
  const explicitInstant =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const timestamp = explicitInstant.test(candidate)
    ? Date.parse(candidate)
    : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return {
      ok: false,
      error: {
        type: "PrimitiveParseError",
        field: "instant",
        value,
        reason: candidate.length === 0 ? "blank" : "invalid-iso-instant",
      },
    };
  }

  // SAFETY: Date.parse accepted the explicit instant and normalization removes offsets.
  return { ok: true, value: new Date(timestamp).toISOString() as IsoInstant };
}

export function parseIanaTimeZone(value: string): ParseResult<IanaTimeZone> {
  const candidate = value.trim();
  if (candidate.length === 0) {
    return {
      ok: false,
      error: {
        type: "PrimitiveParseError",
        field: "timeZone",
        value,
        reason: "blank",
      },
    };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
  } catch {
    return {
      ok: false,
      error: {
        type: "PrimitiveParseError",
        field: "timeZone",
        value,
        reason: "invalid-iana-time-zone",
      },
    };
  }

  // SAFETY: Intl.DateTimeFormat accepted the IANA time-zone identifier.
  return { ok: true, value: candidate as IanaTimeZone };
}

export function deriveCourseRunId(args: {
  courseId: CourseId;
  entryEventId: EventId;
}): CourseRunId {
  // SAFETY: both branded parts are non-blank and the prefix fixes identity meaning.
  return `email-course:${args.courseId}:${args.entryEventId}` as CourseRunId;
}

export function courseIntentKey(args: {
  contactId: ContactId;
  pathId: CoursePathId;
  contentResourceId: ContentResourceId;
}): CourseIntentKey {
  // SAFETY: the branded parts preserve the live contact/path/resource replay boundary.
  return `contact:${args.contactId}:value-path:${args.pathId}:email:${args.contentResourceId}` as CourseIntentKey;
}
