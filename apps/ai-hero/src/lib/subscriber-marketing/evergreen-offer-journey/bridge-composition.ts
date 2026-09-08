import { Effect } from "effect";
import { createBoundedJourneyReaders } from "./bounded-readers";
import {
  createBridgeRuntime,
  type BridgeControl,
  type BridgeClaimSource,
} from "./bridge-runtime";
import {
  createCouponAuthority,
  type CouponAuthorityOptions,
} from "./coupon-authority";
import {
  createMySqlCouponCommerceStore,
  createMySqlCouponReceiptReadStore,
} from "./coupon-authority-mysql";
import { createCouponIntentExecutor } from "./coupon-executor";
import { createCouponReceiptReader } from "./coupon-receipt-reader";
import {
  EVERGREEN_OFFER_JOURNEY_V1,
  EVERGREEN_OFFER_JOURNEY_V2,
} from "./definition";
import { createDrizzleJourneyAttempts } from "./drizzle-attempts";
import { createDrizzleJourneyLedger } from "./drizzle-ledger";
import {
  createOriginalDeliveryMapping,
  createMySqlOriginalMappingPersistence,
} from "./original-delivery-mapping-mysql";
import {
  createRevisionDelivery,
  type ReviewedDeliveryBundle,
} from "./revision-delivery";
import { createEvergreenOfferJourneyService } from "./service";
import {
  createVerifiedOwnerProofReader,
  createMySqlVerifiedOwnerEvidenceReadStore,
} from "./verified-owner-proof";
import type { JourneyClock } from "./ports";
import { createCurrentOfferAuthority } from "./current-authority";
import { createDrizzleCurrentAuthorityRepository } from "./current-authority-repository";

export type BridgeConfiguration =
  | { type: "Disabled" }
  | {
      type: "Configured";
      generation: string;
      approvalReference: string;
      bundles: readonly Omit<
        ReviewedDeliveryBundle,
        "originalMapping" | "mappingWriter"
      >[];
    };

/** Pure configuration inspection. Does not build clients, readers or writers. */
export function inspectBridgeConfiguration(config: BridgeConfiguration) {
  if (config.type === "Disabled") return { type: "Disabled" as const };
  const versions = config.bundles.map(
    (b) => b.manifest.revision.definitionVersion,
  );
  if (
    !config.generation ||
    !config.approvalReference ||
    versions.length !== 2 ||
    !versions.includes(EVERGREEN_OFFER_JOURNEY_V1.definitionVersion) ||
    !versions.includes(EVERGREEN_OFFER_JOURNEY_V2.definitionVersion)
  )
    return {
      type: "Unavailable" as const,
      reason: "ExactReviewedRevisionPairRequired",
    };
  return {
    type: "Configured" as const,
    generation: config.generation,
    productionApprovalProven: false as const,
  };
}

/** Explicit composition root, never imported by a production route/cron.
 * DB handles are injected; constructing a mysql client or leasing secrets is caller work.
 * Factories here are accepted real adapters, not current-config recovery witnesses.
 */
export function createBridgeComposition(input: {
  config: BridgeConfiguration;
  database: Parameters<typeof createDrizzleJourneyLedger>[0];
  commerceDatabase: Parameters<typeof createMySqlCouponCommerceStore>[0];
  ownerReadDatabase: Parameters<
    typeof createMySqlVerifiedOwnerEvidenceReadStore
  >[0];
  authorityDatabase: Parameters<
    typeof createDrizzleCurrentAuthorityRepository
  >[0];
  automationId: string;
  communication: Parameters<
    typeof createCurrentOfferAuthority
  >[0]["communication"];
  control: () => Effect.Effect<BridgeControl, unknown>;
  clock: JourneyClock;
  now: () => string;
  ownerProofSecret: string;
  /** Actual secure source reader from the independently accepted claim lane. */
  claimSource: BridgeClaimSource;
  merchantCouponEvidence: CouponAuthorityOptions["merchantCouponEvidence"];
  kit: Parameters<typeof createRevisionDelivery>[0]["kit"];
}) {
  const inspected = inspectBridgeConfiguration(input.config);
  if (input.config.type === "Disabled") return { type: "Disabled" as const };
  if (inspected.type !== "Configured") return inspected;
  const config = input.config;
  const authority = createCurrentOfferAuthority({
    repository: createDrizzleCurrentAuthorityRepository(
      input.authorityDatabase,
    ),
    automationId: input.automationId,
    communication: input.communication,
    now: () => new Date(input.now()),
  });
  const ledger = createDrizzleJourneyLedger(input.database);
  const attempts = createDrizzleJourneyAttempts(input.database);
  const service = createEvergreenOfferJourneyService({
    ledger,
    authority,
    clock: input.clock,
    definition: EVERGREEN_OFFER_JOURNEY_V2,
  });
  const mapping = createOriginalDeliveryMapping({
    store: createMySqlOriginalMappingPersistence(input.database),
    now: input.now,
  });
  const messages = createRevisionDelivery({
    bundles: config.bundles.map((bundle) => ({
      ...bundle,
      originalMapping: mapping.reader,
      mappingWriter: mapping.writer,
    })),
    dependencies: { ledger, attempts, service, clock: input.clock, authority },
    kit: input.kit,
    now: input.now,
  });
  if (messages.registry().type !== "Configured")
    return { type: "Unavailable" as const, reason: "InvalidReviewedBindings" };
  const proof = createVerifiedOwnerProofReader({
    store: createMySqlVerifiedOwnerEvidenceReadStore(input.ownerReadDatabase),
    secret: input.ownerProofSecret,
    now: input.now,
  });
  const coupons = createCouponIntentExecutor({
    ledger,
    attempts,
    service,
    authority,
    clock: input.clock,
    coupons: createCouponAuthority({
      store: createMySqlCouponCommerceStore(input.commerceDatabase),
      merchantCouponEvidence: input.merchantCouponEvidence,
      readVerifiedOwner: proof,
      now: input.now,
    }),
    receipts: createCouponReceiptReader(
      createMySqlCouponReceiptReadStore(input.commerceDatabase),
    ),
  });
  const readers = createBoundedJourneyReaders(input.database, ledger);
  const runtime = createBridgeRuntime({
    readers,
    service,
    messages,
    coupons,
    clock: input.clock,
    control: input.control,
    claimSource: input.claimSource,
  });
  return {
    type: "Configured" as const,
    runtime,
    service,
    ledger,
    registry: messages.registry,
  };
}
