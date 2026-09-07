import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@/db/schema";
import { automationControl } from "@/db/email-course-schema";
import { evergreenOfferJourneyCommit } from "@/db/evergreen-offer-journey-schema";
import { ACTIVE_PURCHASE_STATUSES } from "@/lib/crash-course-purchaser-tag";
import { EVERGREEN_OFFER_PRODUCT_ID } from "./domain";
import type {
  CurrentAuthorityRepository,
  CurrentPurchaseRow,
} from "./current-authority";

/** SELECT-only. Bounds are fixed by the two supported course paths. */
export function createDrizzleCurrentAuthorityRepository(
  database: MySql2Database<typeof schema>,
): CurrentAuthorityRepository {
  const {
    contact,
    contactState,
    contactLink,
    providerIdentity,
    users,
    purchases,
    entitlements,
    organizationMemberships,
    contentResourceProduct,
    contactEvent,
  } = schema;
  const purchaseFields = {
    id: purchases.id,
    productId: purchases.productId,
    userId: purchases.userId,
    status: purchases.status,
    createdAt: purchases.createdAt,
  };
  return {
    readControl: async (automationId) =>
      (
        await database
          .select({
            automationId: automationControl.automationId,
            control: automationControl.control,
            updatedAt: automationControl.updatedAt,
          })
          .from(automationControl)
          .where(eq(automationControl.automationId, automationId))
          .limit(1)
      )[0] ?? null,
    readIdentity: async (contactId) => {
      const [contacts, states, links, providers] = await Promise.all([
        database
          .select({
            id: contact.id,
            email: contact.email,
            userId: contact.userId,
            lifecycle: contact.lifecycle,
          })
          .from(contact)
          .where(eq(contact.id, contactId))
          .limit(1),
        database
          .select({
            contactId: contactState.contactId,
            lifecycle: contactState.lifecycle,
          })
          .from(contactState)
          .where(eq(contactState.contactId, contactId))
          .limit(2),
        database
          .select({
            contactId: contactLink.contactId,
            userId: contactLink.userId,
          })
          .from(contactLink)
          .where(eq(contactLink.contactId, contactId))
          .limit(2),
        database
          .select({
            contactId: providerIdentity.contactId,
            provider: providerIdentity.provider,
            externalId: providerIdentity.externalId,
          })
          .from(providerIdentity)
          .where(
            and(
              eq(providerIdentity.contactId, contactId),
              eq(providerIdentity.provider, "kit"),
            ),
          )
          .limit(2),
      ]);
      const found = contacts[0];
      if (!found?.email) throw new Error("Contact email is unresolved");
      const linkedIds = [
        ...new Set(
          [found.userId, ...links.map((link) => link.userId)].filter(
            (id): id is string => id !== null,
          ),
        ),
      ];
      const userRows = await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          or(
            eq(users.email, found.email.trim().toLowerCase()),
            linkedIds.length ? inArray(users.id, linkedIds) : undefined,
          ),
        )
        .limit(2);
      if (
        providers.some((provider) => provider.provider !== "kit") ||
        userRows.some((user) => !user.email)
      )
        throw new Error("Identity query mismatch");
      return {
        contact: { ...found, email: found.email },
        states,
        links,
        providers: providers.map((provider) => ({
          ...provider,
          provider: "kit" as const,
        })),
        users: userRows.map((user) => ({ id: user.id, email: user.email! })),
      };
    },
    readExhaustionFacts: async (keys) => {
      if (keys.length !== 2)
        throw new Error("Exhaustion lookup requires both canonical path keys");
      return database
        .select({
          id: contactEvent.id,
          contactId: contactEvent.contactId,
          eventType: contactEvent.eventType,
          semanticIdempotencyKey: contactEvent.semanticIdempotencyKey,
          payloadSummary: contactEvent.payloadSummary,
        })
        .from(contactEvent)
        .where(inArray(contactEvent.semanticIdempotencyKey, [...keys]))
        .limit(2);
    },
    readJourneyHeads: async (ids) => {
      if (ids.length === 0 || ids.length > 2)
        throw new Error("Journey lookup exceeds canonical path bound");
      const heads = await Promise.all(
        ids.map((id) =>
          database
            .select({
              journeyId: evergreenOfferJourneyCommit.journeyId,
              actorVersion: evergreenOfferJourneyCommit.actorVersion,
              snapshot: evergreenOfferJourneyCommit.snapshot,
            })
            .from(evergreenOfferJourneyCommit)
            .where(eq(evergreenOfferJourneyCommit.journeyId, id))
            .orderBy(desc(evergreenOfferJourneyCommit.actorVersion))
            .limit(1),
        ),
      );
      return heads.flat();
    },
    readPurchases: async (userId, now) => {
      const direct = await database
        .select(purchaseFields)
        .from(purchases)
        .where(
          and(
            eq(purchases.userId, userId),
            eq(purchases.productId, EVERGREEN_OFFER_PRODUCT_ID),
            inArray(purchases.status, [...ACTIVE_PURCHASE_STATUSES]),
          ),
        )
        .limit(1);
      if (direct.length)
        return direct.map((row) => ({
          ...row,
          via: "direct" as const,
          beneficiaryUserId: userId,
          effectiveProductId: EVERGREEN_OFFER_PRODUCT_ID,
        }));
      const resources = await database
        .select({ resourceId: contentResourceProduct.resourceId })
        .from(contentResourceProduct)
        .where(eq(contentResourceProduct.productId, EVERGREEN_OFFER_PRODUCT_ID))
        .limit(1);
      if (!resources.length)
        throw new Error("Target product resource mapping unavailable");
      // Match hasEntitlementForResource (entitlements-query.ts): direct or
      // membership ownership, nondeleted, nonexpired, metadata.contentIds.
      // Keep a missing/nonpurchase source visible rather than invent a purchase.
      const accessFields = {
        ...purchaseFields,
        entitlementId: entitlements.id,
        sourceType: entitlements.sourceType,
        effectiveProductId: contentResourceProduct.productId,
      };
      const targetContent = and(
        eq(contentResourceProduct.productId, EVERGREEN_OFFER_PRODUCT_ID),
        sql`JSON_CONTAINS(${entitlements.metadata}, JSON_QUOTE(${contentResourceProduct.resourceId}), '$.contentIds')`,
      );
      const sourcePurchase = and(
        eq(entitlements.sourceType, "PURCHASE"),
        eq(purchases.id, entitlements.sourceId),
      );
      const active = and(
        isNull(entitlements.deletedAt),
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
      );
      // Preserve target-source access when its resource mapping is missing.
      // A NULL effectiveProductId is held by the authority, never a no-owner result.
      // Other source products require an actual target resource match; do not
      // invent a bundle list. Partial mapping completeness remains a hookup gate.
      const relevant = or(
        isNotNull(contentResourceProduct.resourceId),
        eq(purchases.productId, EVERGREEN_OFFER_PRODUCT_ID),
      );
      const [personal, member] = await Promise.all([
        database
          .select(accessFields)
          .from(entitlements)
          .leftJoin(contentResourceProduct, targetContent)
          .leftJoin(purchases, sourcePurchase)
          .where(and(eq(entitlements.userId, userId), active, relevant))
          .limit(1),
        // Ownership is membership ID alone, including NULL/different org IDs.
        // Neither membership userId nor entitlement membershipId has a declared
        // index: query-plan/index readiness remains a hookup gate. LIMIT bounds
        // results, not execution work.
        database
          .select(accessFields)
          .from(organizationMemberships)
          .innerJoin(
            entitlements,
            eq(
              entitlements.organizationMembershipId,
              organizationMemberships.id,
            ),
          )
          .leftJoin(contentResourceProduct, targetContent)
          .leftJoin(purchases, sourcePurchase)
          .where(
            and(eq(organizationMemberships.userId, userId), active, relevant),
          )
          .limit(1),
      ]);
      return [...personal, ...member].map(
        (row): CurrentPurchaseRow => ({
          ...row,
          via: "entitlement",
          beneficiaryUserId: userId,
        }),
      );
    },
  };
}
