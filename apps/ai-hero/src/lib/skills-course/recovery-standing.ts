import {
  activeContactStops,
  firstActiveStop,
  readContactStopSignals,
} from "@/lib/subscriber-marketing/contact-stop-rule";
import {
  JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
  journeyOwnerAssignmentJourneyId,
} from "@/lib/subscriber-marketing/drovr-ownership";
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from "@/lib/subscriber-marketing/drovr-shadow-emitter";
import { SKILLS_WORKFLOW_VALUE_PATH } from "@/lib/subscriber-marketing/skills-newsletter-path-entry";
import type { ContactEventRecord } from "@/lib/subscriber-marketing/types";

/**
 * Whether an email may get a skills-course lesson-one recovery, answered from
 * AI Hero's own records and drovr instead of Kit (off-Kit family 8).
 *
 * - Who: the directory contact for the email and its Kit id alias.
 * - On the course: a `value-path.entered` for the skills path, or a drovr
 *   owner assignment for the skills journey.
 * - Stopped: the local stop rule (planned at course entry, so a lift after
 *   entry never restarts the course) or any active drovr stop.
 *
 * Every read failure is `unknown`, never `subscribed`: callers send nothing
 * and report why.
 */
export type RecoveryStanding =
  | {
      state: "subscribed";
      contactId: string;
      email: string;
      kitSubscriberId: string;
    }
  | { state: "stopped"; reason: string; source: "local" | "drovr" }
  | {
      state: "not-found";
      reason:
        | "contact-not-found"
        | "kit-identity-not-found"
        | "course-entry-not-found";
    }
  | {
      state: "unknown";
      reason:
        | "directory-unreadable"
        | "kit-identity-ambiguous"
        | "local-stops-unreadable"
        | "drovr-stops-unreadable";
    };

export type RecoveryStandingReader = {
  findContactByEmail(
    email: string,
  ): Promise<{ id: string; email?: string | null } | undefined>;
  findKitSubscriberIds(contactId: string): Promise<string[]>;
  findContactEventsByType(
    contactId: string,
    eventType: string,
  ): Promise<ContactEventRecord[]>;
  /** drovr's active all-scope stops for a Kit id. Throws when unreadable. */
  readDrovrStops(kitSubscriberId: string): Promise<{ reason: string }[]>;
};

const SKILLS_PATH_REFERENCE = `value-path:${SKILLS_WORKFLOW_VALUE_PATH}`;

export async function readRecoveryStanding(args: {
  email: string;
  /** The Kit id the caller already trusts (signed token, support request). */
  expectedKitSubscriberId?: string;
  reader: RecoveryStandingReader;
}): Promise<RecoveryStanding> {
  const email = args.email.trim().toLowerCase();
  const { reader } = args;

  let contactId: string;
  let kitSubscriberIds: string[];
  try {
    const contact = await reader.findContactByEmail(email);
    if (!contact || contact.email?.trim().toLowerCase() !== email) {
      return { state: "not-found", reason: "contact-not-found" };
    }
    contactId = contact.id;
    kitSubscriberIds = await reader.findKitSubscriberIds(contactId);
  } catch {
    return { state: "unknown", reason: "directory-unreadable" };
  }

  let kitSubscriberId: string;
  if (args.expectedKitSubscriberId !== undefined) {
    if (!kitSubscriberIds.includes(args.expectedKitSubscriberId)) {
      return { state: "not-found", reason: "kit-identity-not-found" };
    }
    kitSubscriberId = args.expectedKitSubscriberId;
  } else if (kitSubscriberIds.length === 1 && kitSubscriberIds[0]) {
    kitSubscriberId = kitSubscriberIds[0];
  } else if (kitSubscriberIds.length === 0) {
    return { state: "not-found", reason: "kit-identity-not-found" };
  } else {
    return { state: "unknown", reason: "kit-identity-ambiguous" };
  }

  let enteredAt: string | undefined;
  let localStop: string | undefined;
  try {
    enteredAt = await readCourseEnteredAt(reader, contactId);
    if (!enteredAt) {
      return { state: "not-found", reason: "course-entry-not-found" };
    }
    const { signals } = await readContactStopSignals(reader, contactId);
    localStop = firstActiveStop(activeContactStops(signals, enteredAt));
  } catch {
    return { state: "unknown", reason: "local-stops-unreadable" };
  }
  if (localStop)
    return { state: "stopped", reason: localStop, source: "local" };

  let drovrStops: { reason: string }[];
  try {
    drovrStops = await reader.readDrovrStops(kitSubscriberId);
  } catch {
    return { state: "unknown", reason: "drovr-stops-unreadable" };
  }
  if (drovrStops[0]) {
    return { state: "stopped", reason: drovrStops[0].reason, source: "drovr" };
  }

  return { state: "subscribed", contactId, email, kitSubscriberId };
}

/** The earliest readable skills-course entry, if the contact has one. */
async function readCourseEnteredAt(
  reader: RecoveryStandingReader,
  contactId: string,
): Promise<string | undefined> {
  const [entries, owners] = await Promise.all([
    reader.findContactEventsByType(contactId, "value-path.entered"),
    reader.findContactEventsByType(
      contactId,
      JOURNEY_OWNER_ASSIGNED_EVENT_TYPE,
    ),
  ]);
  const times = [
    ...entries
      .filter((entry) => entry.providerReference === SKILLS_PATH_REFERENCE)
      .map((entry) => entry.occurredAt),
    ...owners
      .filter(
        (owner) =>
          journeyOwnerAssignmentJourneyId(owner) ===
          DROVR_SKILLS_COURSE_JOURNEY_ID,
      )
      .map((owner) => owner.occurredAt),
  ].filter((at) => Number.isFinite(Date.parse(at)));
  return times.reduce<string | undefined>(
    (earliest, at) =>
      earliest === undefined || Date.parse(at) < Date.parse(earliest)
        ? at
        : earliest,
    undefined,
  );
}
