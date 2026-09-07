import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";

import {
  DEFAULT_EMAIL_PREFERENCE_KEY,
  emailPreferenceDefinitionByKey,
} from "@/coursebuilder/email-preferences";
import { ACTIVE_PURCHASE_STATUSES } from "@/lib/crash-course-purchaser-tag";
import { restoreAutomationControl } from "../email-course/restoration";
import {
  COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE,
  COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT,
  courseSequenceExhaustionFactKey,
  readCoursePayload,
  restoreCourseSequenceExhaustedPayload,
} from "../course-sequence-exhaustion";
import { SKILLS_WORKFLOW_PATH_SLUGS } from "../skills-workflow-path";
import { EVERGREEN_OFFER_PRODUCT_ID, type EligibilityFacts } from "./domain";
import type { JourneyCommandError, OfferAuthority } from "./ports";
import {
  deriveJourneyId,
  parseEntryFactId,
  parseIsoInstant,
} from "./primitives";
import {
  EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
  restoreEvergreenOfferJourneySnapshot,
} from "./restoration";

const Text = z.string().min(1);
const ControlRow = z.object({
  automationId: Text,
  control: z.unknown(),
  updatedAt: z.date(),
});
const IdentityRows = z.object({
  contact: z
    .object({
      id: Text,
      email: z.string().email(),
      userId: z.string().nullable(),
      lifecycle: Text,
    })
    .nullable(),
  states: z.array(z.object({ contactId: Text, lifecycle: Text })).max(2),
  links: z.array(z.object({ contactId: Text, userId: Text })).max(2),
  providers: z
    .array(
      z.object({
        contactId: Text,
        provider: z.literal("kit"),
        externalId: Text,
      }),
    )
    .max(2),
  users: z.array(z.object({ id: Text, email: z.string().email() })).max(2),
});
export type CurrentIdentityRows = z.infer<typeof IdentityRows>;
export type ExhaustionRow = {
  id: string;
  contactId: string;
  eventType: string;
  semanticIdempotencyKey: string;
  payloadSummary: unknown;
};
export type JourneyHeadRow = {
  journeyId: string;
  actorVersion: number;
  snapshot: unknown;
};
export type CurrentPurchaseRow = {
  id: string | null;
  productId: string | null;
  userId: string | null;
  status: string | null;
  createdAt: Date | null;
  via: "direct" | "entitlement";
  beneficiaryUserId: string;
  effectiveProductId: string;
  sourceType?: string;
  entitlementId?: string;
};
export interface CurrentAuthorityRepository {
  readControl: (
    automationId: string,
  ) => Promise<z.infer<typeof ControlRow> | null>;
  readIdentity: (contactId: string) => Promise<CurrentIdentityRows>;
  readExhaustionFacts: (keys: readonly string[]) => Promise<ExhaustionRow[]>;
  readJourneyHeads: (
    journeyIds: readonly string[],
  ) => Promise<JourneyHeadRow[]>;
  readPurchases: (userId: string, now: Date) => Promise<CurrentPurchaseRow[]>;
}
export type CurrentCommunicationEvidence = {
  subscriberId: string;
  email: string;
  delivery: EligibilityFacts["delivery"];
  readAt: string;
  evidence: string;
};
export interface CurrentCommunicationReader {
  read: (identity: {
    subscriberId: string;
    email: string;
  }) => Promise<CurrentCommunicationEvidence>;
}
class AuthorityReadFailure extends Error {
  constructor(
    readonly issue: Extract<
      JourneyCommandError,
      { type: "AuthorityUnavailable" | "AuthorityInconsistent" }
    >,
  ) {
    super(issue.reason);
  }
}
function unavailable(reason: string): never {
  throw new AuthorityReadFailure({ type: "AuthorityUnavailable", reason });
}
function inconsistent(reason: string): never {
  throw new AuthorityReadFailure({ type: "AuthorityInconsistent", reason });
}
function instant(date: Date) {
  if (!Number.isFinite(date.getTime()))
    return unavailable("Authority clock is invalid");
  const parsed = parseIsoInstant(date.toISOString());
  if (!parsed.ok) return unavailable("Authority clock is invalid");
  return parsed.value;
}
const normalizedEmail = (email: string) => email.trim().toLowerCase();

/** No cache, writes, provider client construction or default automation ID. */
export function createCurrentOfferAuthority(args: {
  repository: CurrentAuthorityRepository;
  automationId: string;
  communication: CurrentCommunicationReader;
  now: () => Date;
}): OfferAuthority {
  return {
    currentFacts: (query) =>
      Effect.tryPromise({
        try: async () => {
          const startedAt = instant(args.now());
          if (
            !args.automationId ||
            args.automationId.trim() !== args.automationId
          )
            return inconsistent("Exact automation ID is required");
          const rawControl = await args.repository.readControl(
            args.automationId,
          );
          if (rawControl === null)
            return unavailable("Missing automation control");
          const row = ControlRow.safeParse(rawControl);
          if (!row.success || row.data.automationId !== args.automationId)
            return inconsistent("Invalid or mismatched automation control row");
          const restoredControl = restoreAutomationControl(row.data.control);
          if (!restoredControl.ok)
            return inconsistent("Malformed automation control");
          const control = restoredControl.value;
          if (control.type === "Stopped" && control.source === "Missing")
            return unavailable("Missing automation control");
          const parsed = IdentityRows.safeParse(
            await args.repository.readIdentity(query.contactId),
          );
          if (!parsed.success)
            return inconsistent("Malformed current identity rows");
          const identity = parsed.data;
          const contact = identity.contact;
          if (!contact || contact.id !== query.contactId)
            return unavailable("Contact identity is unresolved");
          if (
            identity.providers.length !== 1 ||
            identity.users.length > 1 ||
            identity.links.length > 1 ||
            identity.states.length !== 1
          )
            return unavailable(
              "Ambiguous or incomplete current identity/suppression evidence",
            );
          const provider = identity.providers[0]!;
          const state = identity.states[0]!;
          if (
            provider.contactId !== contact.id ||
            state.contactId !== contact.id ||
            identity.links.some((link) => link.contactId !== contact.id)
          )
            return inconsistent("Identity rows belong to another contact");
          const user = identity.users[0];
          const linkedIds = new Set(
            [
              contact.userId,
              ...identity.links.map((link) => link.userId),
            ].filter((id): id is string => id !== null),
          );
          if (
            linkedIds.size > 1 ||
            (linkedIds.size > 0 && (!user || !linkedIds.has(user.id))) ||
            (user &&
              normalizedEmail(user.email) !== normalizedEmail(contact.email))
          )
            return inconsistent("Conflicting contact/user identity");
          // A User/ContactLink match is a purchase lookup, NOT verified-account or
          // coupon-claim authority. Current provider ID/email must still agree.
          const communication = await args.communication.read({
            subscriberId: provider.externalId,
            email: normalizedEmail(contact.email),
          });
          if (
            communication.subscriberId !== provider.externalId ||
            normalizedEmail(communication.email) !==
              normalizedEmail(contact.email)
          )
            return inconsistent(
              "Current provider identity disagrees with contact",
            );
          const providerAt = parseIsoInstant(communication.readAt);
          if (
            !providerAt.ok ||
            providerAt.value < startedAt ||
            !communication.evidence
          )
            return unavailable(
              "Current communication evidence is missing or stale",
            );
          const knownLifecycle = new Set([
            "new",
            "classified",
            "nurture-ready",
            "human-review",
            "suppressed",
            "customer",
          ]);
          if (
            !knownLifecycle.has(contact.lifecycle) ||
            !knownLifecycle.has(state.lifecycle)
          )
            return unavailable("Unknown or stale local suppression state");
          const delivery =
            contact.lifecycle === "suppressed" ||
            state.lifecycle === "suppressed"
              ? {
                  type: "Suppressed" as const,
                  evidence: "current-contact-suppression",
                }
              : communication.delivery;
          const deliveryShape = z
            .union([
              z.object({ type: z.literal("Eligible") }),
              z.object({
                type: z.enum(["Unsubscribed", "Suppressed", "Undeliverable"]),
                evidence: Text,
              }),
            ])
            .safeParse(delivery);
          if (!deliveryShape.success)
            return unavailable("Unknown communication decision");

          const keys = SKILLS_WORKFLOW_PATH_SLUGS.map((valuePathId) =>
            courseSequenceExhaustionFactKey({
              contactId: query.contactId,
              valuePathId,
            }),
          );
          const sources = await args.repository.readExhaustionFacts(keys);
          if (sources.length === 0 || sources.length > keys.length)
            return unavailable("Canonical exhaustion lookup is incomplete");
          const expected = new Map<
            string,
            { entryId: string; valuePathId: string }
          >();
          const seenKeys = new Set<string>();
          for (const source of sources) {
            const stored = readCoursePayload(source.payloadSummary);
            const payload = restoreCourseSequenceExhaustedPayload(
              stored?.payload,
            );
            const entryId = parseEntryFactId(source.id);
            if (
              !payload ||
              !entryId.ok ||
              stored?.format !== COURSE_SEQUENCE_EXHAUSTED_PAYLOAD_FORMAT ||
              source.eventType !== COURSE_SEQUENCE_EXHAUSTED_EVENT_TYPE ||
              source.contactId !== query.contactId ||
              payload.actor.contactId !== query.contactId ||
              !keys.includes(source.semanticIdempotencyKey) ||
              source.semanticIdempotencyKey !==
                courseSequenceExhaustionFactKey({
                  contactId: query.contactId,
                  valuePathId: payload.actor.valuePathId,
                }) ||
              seenKeys.has(source.semanticIdempotencyKey)
            )
              return inconsistent("Invalid canonical exhaustion evidence");
            seenKeys.add(source.semanticIdempotencyKey);
            expected.set(deriveJourneyId(entryId.value), {
              entryId: source.id,
              valuePathId: payload.actor.valuePathId,
            });
          }
          const heads = await args.repository.readJourneyHeads([
            ...expected.keys(),
          ]);
          if (heads.length > 1)
            return inconsistent(
              "Multiple journeys already exist for this contact",
            );
          let existingJourneyId: EligibilityFacts["existingJourneyId"] = null;
          for (const head of heads) {
            const source = expected.get(head.journeyId);
            const restored = restoreEvergreenOfferJourneySnapshot(
              JSON.stringify({
                format: EVERGREEN_OFFER_JOURNEY_SNAPSHOT_FORMAT,
                journeyId: head.journeyId,
                actorVersion: head.actorVersion,
                aggregate: head.snapshot,
              }),
            );
            if (
              !source ||
              !restored.ok ||
              restored.value.contactId !== query.contactId ||
              restored.value.entryFactId !== source.entryId ||
              restored.value.valuePathId !== source.valuePathId
            )
              return inconsistent(
                "Journey head does not match canonical contact/source",
              );
            existingJourneyId = restored.value.journeyId;
          }
          if (query.journeyId !== null && existingJourneyId !== query.journeyId)
            return inconsistent(
              "Requested journey is not the canonical contact journey",
            );

          const purchases = user
            ? await args.repository.readPurchases(user.id, args.now())
            : [];
          if (purchases.length > 2)
            return inconsistent("Purchase lookup exceeded its bound");
          let purchase: EligibilityFacts["purchase"] = null;
          for (const row of purchases) {
            if (
              !["direct", "entitlement"].includes(row.via) ||
              !user ||
              row.beneficiaryUserId !== user.id ||
              row.effectiveProductId !== EVERGREEN_OFFER_PRODUCT_ID ||
              !row.id ||
              !row.productId ||
              !row.createdAt ||
              !ACTIVE_PURCHASE_STATUSES.some(
                (status) => status === row.status,
              ) ||
              (row.via === "direct" &&
                (row.userId !== user.id ||
                  row.productId !== EVERGREEN_OFFER_PRODUCT_ID)) ||
              (row.via === "entitlement" &&
                (row.sourceType !== "PURCHASE" || !row.entitlementId))
            )
              return inconsistent(
                "Purchase/fulfillment evidence is unresolved or mismatched",
              );
            purchase = {
              purchaseId: row.id,
              sourceProductId: row.productId,
              offerProductFamily: "ai-coding-crash-course",
              purchasedAt: instant(row.createdAt),
              sourceReference:
                row.via === "entitlement"
                  ? `entitlement:${row.entitlementId}:purchase:${row.id}`
                  : `purchase:${row.id}`,
            };
          }
          const readAt = instant(args.now());
          if (providerAt.value > readAt)
            return inconsistent("Communication evidence is from the future");
          const evidenceVersion = `evergreen-authority.v1:${createHash("sha256")
            .update(
              JSON.stringify({
                startedAt,
                readAt,
                controlUpdatedAt: row.data.updatedAt,
                control,
                delivery,
                communicationEvidence: communication.evidence,
                providerAt: providerAt.value,
                identity,
                sources,
                heads,
                purchase,
              }),
            )
            .digest("hex")}`;
          return {
            contactId: query.contactId,
            purchase,
            delivery,
            existingJourneyId,
            automationControl:
              control.type === "Enabled"
                ? { type: "Enabled", version: control.version }
                : {
                    type: "Stopped",
                    version: control.version,
                    reason: control.reason,
                  },
            evidenceVersion,
            readAt,
          };
        },
        catch: (error) =>
          error instanceof AuthorityReadFailure
            ? error.issue
            : {
                type: "AuthorityUnavailable",
                reason: "Current authority storage or provider read failed",
              },
      }),
  };
}

/** Uses raw current provider state, never preference helpers' defaultSubscribed. */
export function createKitCurrentCommunicationReader(args: {
  getSubscriber: (subscriberId: string) => Promise<unknown>;
  now: () => Date;
}): CurrentCommunicationReader {
  return {
    read: async (identity) => {
      const result = await args.getSubscriber(identity.subscriberId);
      const parsed = z
        .object({
          id: z.union([z.number().int().positive(), Text]),
          email_address: z.string().email(),
          state: Text,
          fields: z.record(z.string().nullable()).optional(),
          suppressed: z.unknown().optional(),
          bounced: z.unknown().optional(),
          complained: z.unknown().optional(),
          unsubscribed: z.unknown().optional(),
        })
        .safeParse(result);
      if (!parsed.success)
        return unavailable("Provider subscriber state is unresolved");
      const subscriber = parsed.data;
      if (
        [
          subscriber.suppressed,
          subscriber.bounced,
          subscriber.complained,
          subscriber.unsubscribed,
        ].some((value) => value !== undefined)
      )
        return unavailable(
          "Unsupported provider communication flag requires explicit evidence mapping",
        );
      if (
        String(subscriber.id) !== identity.subscriberId ||
        normalizedEmail(subscriber.email_address) !==
          normalizedEmail(identity.email)
      )
        return inconsistent("Provider subscriber identity mismatch");
      const preference =
        emailPreferenceDefinitionByKey[DEFAULT_EMAIL_PREFERENCE_KEY];
      const raw = subscriber.fields?.[preference.field]?.trim().toLowerCase();
      let delivery: EligibilityFacts["delivery"];
      if (subscriber.state === "cancelled" || raw === "unsubscribed")
        delivery = {
          type: "Unsubscribed",
          evidence: "current-provider-opt-out",
        };
      else if (
        subscriber.state === "bounced" ||
        subscriber.state === "complained"
      )
        delivery = {
          type: "Undeliverable",
          evidence: `current-provider-${subscriber.state}`,
        };
      else if (subscriber.state === "active" && raw === "subscribed")
        delivery = { type: "Eligible" };
      else
        return unavailable(
          "Provider communication status is unknown or unconfirmed",
        );
      return {
        subscriberId: String(subscriber.id),
        email: normalizedEmail(subscriber.email_address),
        delivery,
        readAt: instant(args.now()),
        evidence: `kit-current:${subscriber.state}:${raw ?? "unset"}`,
      };
    },
  };
}
