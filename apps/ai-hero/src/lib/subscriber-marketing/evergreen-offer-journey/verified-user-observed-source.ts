import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, asc, sql, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
  contactEvent,
  providerIdentity,
  users,
  sessions,
  coupon,
} from "@/db/schema";
import { evergreenOfferJourneyCommit } from "@/db/evergreen-offer-journey-schema";
import { lookupIndexedEmailContact } from "../contact-email-lookup";
import { normalizeEmail } from "../contact-email-equivalence";
import type { EvergreenOfferJourneyDatabase } from "./drizzle-ledger";
import type { EmailObservationTransactions } from "./email-observation-transaction";
import type {
  JourneyLedger,
  OfferAuthority,
  EvergreenOfferJourneyService,
} from "./ports";
import type { VerifiedUserObserved } from "./domain";
import { readCouponEvidence } from "./coupon-authority";
import { restoreEvergreenOfferStimulus } from "./persistence-codec";
import {
  EMAIL_TOKEN_LOGIN_OBSERVED,
  OFFER_CLAIM_OBSERVED,
  emailFingerprint,
  sessionTokenHash,
  emailTokenLoginObservedSchema,
  offerClaimObservedSchema,
  emailTokenLoginEventRow,
  offerClaimEventRow,
  claimSemanticKey,
  claimSourceReference,
  resolveOwnerContact,
  type OfferClaimObservedPayload,
} from "./verified-owner-evidence";

type Session = { readonly userId: string; readonly sessionToken: string };
type EventRow = typeof contactEvent.$inferSelect;
type WriteDb = Parameters<
  Parameters<EmailObservationTransactions["run"]>[0]
>[0];
const claimId = (payload: OfferClaimObservedPayload) =>
  `eoc_${createHash("sha256").update(claimSemanticKey(payload)).digest("hex")}`;
function exactRow(
  actual: EventRow,
  expected: typeof contactEvent.$inferInsert,
) {
  const { createdAt, ...row } = actual;
  return (
    createdAt instanceof Date &&
    Number.isFinite(createdAt.getTime()) &&
    isDeepStrictEqual(row, expected)
  );
}
function stimulus(row: EventRow): VerifiedUserObserved | null {
  const payload = offerClaimObservedSchema.safeParse(row.payloadSummary);
  if (!payload.success || row.eventType !== OFFER_CLAIM_OBSERVED) return null;
  const decoded = restoreEvergreenOfferStimulus({
    type: "VerifiedUserObserved",
    stimulusId: row.id,
    journeyId: payload.data.journeyId,
    verifiedUserId: payload.data.verifiedUserId,
    observedAt: payload.data.observedAt,
    sourceReference: claimSourceReference(row.id),
  });
  return decoded.ok && decoded.value.type === "VerifiedUserObserved"
    ? decoded.value
    : null;
}
class ClaimHeld extends Error {}
const hold = (): never => {
  throw new ClaimHeld("Claim unavailable");
};

/** Unregistered. All identifiers derive from the actual session/account, never
 * URL/form selectors. Source commit precedes advance; recovery never grants. */
export function createVerifiedUserObservedSource(options: {
  transactions: EmailObservationTransactions;
  readback: Pick<EvergreenOfferJourneyDatabase, "select">;
  ledger: JourneyLedger;
  authority: OfferAuthority;
  service: Pick<EvergreenOfferJourneyService, "advance">;
  secret: string;
  now: () => Date;
}) {
  if (!options.secret) throw new Error("Claim evidence secret required");
  const eventById = async (id: string) =>
    (
      await options.readback
        .select()
        .from(contactEvent)
        .where(eq(contactEvent.id, id))
        .limit(1)
    )[0];
  async function context(tx: WriteDb, session: Session) {
    // Preliminary email is a lookup hint only; locked User/session below decides.
    const preliminary = (
      await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1)
    )[0];
    if (!preliminary) return hold();
    const owner = await lookupIndexedEmailContact(
      tx,
      normalizeEmail(preliminary.email),
    );
    if (!owner) return hold();
    const user = (
      await tx
        .select()
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1)
        .for("update")
    )[0];
    const current = (
      await tx
        .select()
        .from(sessions)
        .where(eq(sessions.sessionToken, session.sessionToken))
        .limit(1)
        .for("update")
    )[0];
    const now = options.now();
    if (
      !user?.emailVerified ||
      user.id !== session.userId ||
      !current ||
      current.sessionToken !== session.sessionToken ||
      current.userId !== user.id ||
      current.expires <= now ||
      normalizeEmail(user.email) !== normalizeEmail(owner.email)
    )
      return hold();
    const identities = await tx
      .select()
      .from(providerIdentity)
      .where(
        and(
          eq(providerIdentity.contactId, owner.id),
          eq(providerIdentity.provider, "kit"),
        ),
      )
      .limit(2)
      .for("update");
    if (identities.length !== 1 || !identities[0]) return hold();
    const identity = { ...identities[0], provider: "kit" as const };
    const logins = await tx
      .select()
      .from(contactEvent)
      .where(
        and(
          eq(contactEvent.contactId, owner.id),
          eq(contactEvent.eventType, EMAIL_TOKEN_LOGIN_OBSERVED),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${contactEvent.payloadSummary}, '$.sessionTokenHash')) = ${sessionTokenHash(options.secret, session.sessionToken)}`,
        ),
      )
      .limit(2);
    if (logins.length !== 1 || !logins[0]) return hold();
    const loginRow = logins[0],
      login = emailTokenLoginObservedSchema.parse(loginRow.payloadSummary);
    if (
      login.userId !== user.id ||
      login.contactId !== owner.id ||
      login.sessionTokenHash !==
        sessionTokenHash(options.secret, session.sessionToken) ||
      login.emailFingerprint !== emailFingerprint(options.secret, user.email) ||
      login.verifiedAt !== user.emailVerified.toISOString() ||
      Date.parse(login.verifiedAt) > Date.parse(login.observedAt) ||
      Date.parse(login.observedAt) > now.getTime()
    )
      return hold();
    const resolution = resolveOwnerContact([owner.id], owner.id);
    if (
      !exactRow(
        loginRow,
        emailTokenLoginEventRow({
          id: loginRow.id,
          identity,
          resolution,
          payload: login,
        }),
      )
    )
      return hold();
    const legacy = await tx
      .select({ id: evergreenOfferJourneyCommit.journeyId })
      .from(evergreenOfferJourneyCommit)
      .where(
        and(
          eq(evergreenOfferJourneyCommit.actorVersion, 1),
          isNull(evergreenOfferJourneyCommit.admissionContactId),
        ),
      )
      .limit(1);
    if (legacy.length) return hold();
    const admissions = await tx
      .select({ journeyId: evergreenOfferJourneyCommit.journeyId })
      .from(evergreenOfferJourneyCommit)
      .where(eq(evergreenOfferJourneyCommit.admissionContactId, owner.id))
      .limit(2);
    if (admissions.length !== 1 || !admissions[0]) return hold();
    const decoded = restoreEvergreenOfferStimulus({
      type: "VerifiedUserObserved",
      stimulusId: "lookup",
      journeyId: admissions[0].journeyId,
      verifiedUserId: user.id,
      observedAt: now.toISOString(),
      sourceReference: "lookup",
    });
    if (!decoded.ok || decoded.value.type !== "VerifiedUserObserved")
      return hold();
    const journey = await Effect.runPromise(
      options.ledger.load(decoded.value.journeyId),
    );
    if (
      !journey ||
      journey.contactId !== owner.id ||
      (journey.phase !== "pitch.running" &&
        journey.phase !== "handoff.awaitingReceipt") ||
      !journey.coupon
    )
      return hold();
    const facts = await Effect.runPromise(
      options.authority.currentFacts({
        contactId: journey.contactId,
        journeyId: journey.journeyId,
      }),
    );
    if (
      facts.contactId !== owner.id ||
      facts.existingJourneyId !== journey.journeyId ||
      facts.purchase ||
      facts.delivery.type !== "Eligible" ||
      facts.automationControl.type !== "Enabled"
    )
      return hold();
    const realCoupon = (
      await tx
        .select()
        .from(coupon)
        .where(eq(coupon.id, journey.coupon.couponId))
        .limit(1)
        .for("update")
    )[0];
    if (
      !realCoupon ||
      realCoupon.id !== journey.coupon.couponId ||
      realCoupon.status !== 1 ||
      realCoupon.usedCount !== 0
    )
      return hold();
    const evidence = readCouponEvidence(realCoupon);
    const fresh = options.now();
    if (
      evidence.issue.journeyId !== journey.journeyId ||
      evidence.coupon.contactId !== owner.id ||
      fresh.getTime() < Date.parse(evidence.coupon.issuedAt) ||
      fresh.getTime() >= Date.parse(evidence.coupon.expiresAt) ||
      current.expires <= fresh
    )
      return hold();
    for (const binding of [journey.coupon.binding, evidence.coupon.binding])
      if (
        binding.type !== "AwaitingVerifiedUser" &&
        binding.verifiedUserId !== user.id
      )
        return hold();
    return { identity, resolution, journey, user, login, loginRow, now: fresh };
  }
  async function capture(session: Session, write: boolean) {
    let expected: ReturnType<typeof offerClaimEventRow> | undefined;
    try {
      const status = await options.transactions.run(async (tx) => {
        const c = await context(tx, session);
        if (!write)
          return c.journey.coupon?.binding.type === "BoundToVerifiedUser"
            ? ("bound" as const)
            : c.journey.coupon?.binding.type === "BindingIntentCommitted"
              ? ("pending" as const)
              : ("ready" as const);
        const payload: OfferClaimObservedPayload = {
          version: 1,
          journeyId: c.journey.journeyId,
          contactId: c.login.contactId,
          verifiedUserId: c.user.id,
          attestationEventId: c.loginRow.id,
          sessionTokenHash: c.login.sessionTokenHash,
          emailFingerprint: c.login.emailFingerprint,
          verifiedAt: c.login.verifiedAt,
          observedAt: c.now.toISOString(),
        };
        // Preserve the first event's original observedAt for exact semantic replay.
        const prior = (
          await tx
            .select()
            .from(contactEvent)
            .where(
              eq(
                contactEvent.semanticIdempotencyKey,
                claimSemanticKey(payload),
              ),
            )
            .limit(1)
        )[0];
        if (prior) {
          const p = offerClaimObservedSchema.parse(prior.payloadSummary);
          if (
            !isDeepStrictEqual(
              { ...p, observedAt: payload.observedAt },
              payload,
            ) ||
            Date.parse(p.observedAt) > c.now.getTime() ||
            Date.parse(p.observedAt) < Date.parse(c.login.observedAt)
          )
            return hold();
          payload.observedAt = p.observedAt;
        }
        expected = offerClaimEventRow({
          id: claimId(payload),
          identity: c.identity,
          resolution: c.resolution,
          payload,
        });
        if (prior) {
          if (!exactRow(prior, expected)) {
            expected = undefined;
            return hold();
          }
        } else await tx.insert(contactEvent).values(expected);
        return "pending" as const;
      });
      if (!write) return { status };
    } catch {
      if (!expected) return { status: "unavailable" as const };
    }
    if (!expected) return { status: "unavailable" as const };
    try {
      const row = await eventById(expected.id!);
      if (!row || !exactRow(row, expected))
        return { status: "unavailable" as const };
      const fact = stimulus(row);
      if (!fact) return { status: "unavailable" as const };
      try {
        await Effect.runPromise(options.service.advance(fact));
      } catch {
        /* Durable source remains available to recovery. */
      }
      return { status: "pending" as const };
    } catch {
      return { status: "unavailable" as const };
    }
  }
  return {
    status: async (session: Session) => (await capture(session, false)).status,
    claim: async (session: Session) => (await capture(session, true)).status,
  };
}

/** Bounded persisted source validation; no session-current assertion or grant.
 * Recovery still delegates current authority to advance/executor/proof reader. */
export function createVerifiedUserObservedReader(
  database: Pick<EvergreenOfferJourneyDatabase, "select">,
) {
  return {
    async page(input: { after?: string; limit: number }) {
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new Error("Invalid claim page limit");
      const rows = await database
        .select()
        .from(contactEvent)
        .where(
          and(
            eq(contactEvent.eventType, OFFER_CLAIM_OBSERVED),
            input.after ? gt(contactEvent.id, input.after) : undefined,
          ),
        )
        .orderBy(asc(contactEvent.id))
        .limit(input.limit);
      const candidates: VerifiedUserObserved[] = [];
      const held: string[] = [];
      for (const row of rows) {
        try {
          const payload = offerClaimObservedSchema.parse(row.payloadSummary);
          const identity = (
            await database
              .select()
              .from(providerIdentity)
              .where(eq(providerIdentity.id, row.providerIdentityId))
              .limit(1)
          )[0];
          if (!identity || identity.provider !== "kit") throw new ClaimHeld();
          const expected = offerClaimEventRow({
            id: claimId(payload),
            payload,
            identity: { ...identity, provider: "kit" },
            resolution: resolveOwnerContact(
              [identity.contactId],
              payload.contactId,
            ),
          });
          const fact = stimulus(row);
          if (!fact || !exactRow(row, expected)) throw new ClaimHeld();
          const loginRow = (
            await database
              .select()
              .from(contactEvent)
              .where(eq(contactEvent.id, payload.attestationEventId))
              .limit(1)
          )[0];
          if (!loginRow || loginRow.id !== payload.attestationEventId)
            throw new ClaimHeld();
          const login = emailTokenLoginObservedSchema.parse(
            loginRow.payloadSummary,
          );
          if (
            login.userId !== payload.verifiedUserId ||
            login.contactId !== payload.contactId ||
            login.sessionTokenHash !== payload.sessionTokenHash ||
            login.emailFingerprint !== payload.emailFingerprint ||
            login.verifiedAt !== payload.verifiedAt ||
            Date.parse(login.verifiedAt) > Date.parse(login.observedAt) ||
            Date.parse(login.observedAt) > Date.parse(payload.observedAt)
          )
            throw new ClaimHeld();
          if (
            !exactRow(
              loginRow,
              emailTokenLoginEventRow({
                id: loginRow.id,
                payload: login,
                identity: { ...identity, provider: "kit" },
                resolution: resolveOwnerContact(
                  [identity.contactId],
                  payload.contactId,
                ),
              }),
            )
          )
            throw new ClaimHeld();
          candidates.push(fact);
        } catch {
          held.push(row.id);
        }
      }
      return {
        type: "Scanned" as const,
        candidates,
        held,
        cursor: rows.at(-1)?.id ?? input.after ?? null,
      };
    },
  };
}
