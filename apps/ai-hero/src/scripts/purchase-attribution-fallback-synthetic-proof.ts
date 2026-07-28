import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { db } from "@/db";
import {
  contact,
  contactEvent,
  contactLink,
  contactState,
  googleAdsConversionUpload,
  nextAction,
  products,
  providerIdentity,
  purchases,
  sideEffectIntent,
  stateTransition,
  users,
} from "@/db/schema";
import {
  isClickWithinGoogleUploadWindow,
  processGoogleAdsConversionUploads,
  readGoogleAdsConversionUploadConfig,
} from "@/lib/google-ads-conversion-upload";
import { captureNormalizedContactEvent } from "@/lib/subscriber-marketing/capture-contact-event";
import { DrizzleCaptureMarketingRepository } from "@/lib/subscriber-marketing/drizzle-capture-repository";
import { normalizeContactEvent } from "@/lib/subscriber-marketing/normalize-contact-event";
import { and, eq } from "drizzle-orm";

const FIXTURE_NAMESPACE = "aih-purchase-fallback-proof-20260717";
const USER_ID = `${FIXTURE_NAMESPACE}:user`;
const CONTACT_ID = `${FIXTURE_NAMESPACE}:contact:1`;
const PURCHASE_ID = `${FIXTURE_NAMESPACE}:purchase`;
const KIT_SUBSCRIBER_ID = `${FIXTURE_NAMESPACE}:kit-subscriber`;
const PROVIDER_EVENT_ID = `${FIXTURE_NAMESPACE}:skills-signup`;
const FIXTURE_EMAIL = `joel+${FIXTURE_NAMESPACE}@badass.dev`;
const ALTERED_BUYER_EMAIL = `joel+${FIXTURE_NAMESPACE}-altered@badass.dev`;
const FORMAT_VALID_SYNTHETIC_GCLID =
  "Cj0KCQjSYNTHETICPURCHASEFALLBACKPROOF20260717AIHERO";
const TEST_GCLID = "TEST_purchase_fallback_proof_20260717";
const DEFAULT_RECEIPT_PATH =
  "/Users/joel/Code/badass-courses/aihero-support/.brain/data/ads/email-course/receipts/2026-07-17-purchase-fallback-synthetic-proof.json";

let googleUploadAttempts = 0;
const noGoogleWriteClient = {
  async upload() {
    googleUploadAttempts += 1;
    throw new Error(
      "Dry-run proof attempted to call the Google Ads upload client",
    );
  },
};

type ScanSummary = Awaited<
  ReturnType<typeof processGoogleAdsConversionUploads>
>;
type AssertionReceipt = {
  name: string;
  passed: boolean;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
};
type CleanupReadback = Record<string, number>;

class SyntheticProofCaptureRepository extends DrizzleCaptureMarketingRepository {
  private readonly sequences = new Map<string, number>();

  override newId(kind: string) {
    const next = (this.sequences.get(kind) ?? 0) + 1;
    this.sequences.set(kind, next);
    return `${FIXTURE_NAMESPACE}:${kind}:${next}`;
  }
}

function hasFlag(argv: readonly string[], flag: string) {
  return argv.includes(flag);
}

function readFlag(argv: readonly string[], flag: string) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function summarySnapshot(summary: ScanSummary) {
  return {
    mode: summary.mode,
    checked: summary.checked,
    candidates: summary.candidates,
    eligible: summary.eligible,
    fallbackCandidates: summary.fallbackCandidates,
    fallbackResolved: summary.fallbackResolved,
    dryRunEligible: summary.dryRunEligible,
    uploaded: summary.uploaded,
    validated: summary.validated,
    skipped: summary.skipped,
    failed: summary.failed,
    byReason: summary.byReason,
    byAttributionSource: summary.byAttributionSource,
    byFallbackResolution: summary.byFallbackResolution,
    byResultStatus: summary.byResultStatus,
  };
}

function matchingHappyPathSummary(
  summary: ScanSummary,
  resolution: "buyer-email" | "kit-provider-identity",
) {
  return (
    summary.mode === "dry-run" &&
    summary.checked === 1 &&
    summary.candidates === 1 &&
    summary.eligible === 1 &&
    summary.fallbackCandidates === 1 &&
    summary.fallbackResolved === 1 &&
    summary.dryRunEligible === 1 &&
    summary.uploaded === 0 &&
    summary.validated === 0 &&
    summary.failed === 0 &&
    summary.byAttributionSource["signup-gclid-fallback"] === 1 &&
    summary.byFallbackResolution[resolution] === 1 &&
    summary.byResultStatus["dry-run"] === 1
  );
}

function matchingGuardSummary(summary: ScanSummary, reason: string) {
  return (
    summary.mode === "dry-run" &&
    summary.checked === 1 &&
    summary.candidates === 1 &&
    summary.eligible === 0 &&
    summary.fallbackResolved === 0 &&
    summary.dryRunEligible === 0 &&
    summary.uploaded === 0 &&
    summary.validated === 0 &&
    summary.failed === 0 &&
    summary.skipped === 1 &&
    summary.byReason[reason] === 1
  );
}

async function readbackFixtureRows(): Promise<CleanupReadback> {
  const [
    userRows,
    contactRows,
    identityRows,
    eventRows,
    stateRows,
    transitionRows,
    nextActionRows,
    intentRows,
    linkRows,
    purchaseRows,
    ledgerRows,
  ] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, USER_ID)),
    db
      .select({ id: contact.id })
      .from(contact)
      .where(eq(contact.id, CONTACT_ID)),
    db
      .select({ id: providerIdentity.id })
      .from(providerIdentity)
      .where(
        and(
          eq(providerIdentity.provider, "kit"),
          eq(providerIdentity.externalId, KIT_SUBSCRIBER_ID),
        ),
      ),
    db
      .select({ id: contactEvent.id })
      .from(contactEvent)
      .where(eq(contactEvent.providerEventId, PROVIDER_EVENT_ID)),
    db
      .select({ id: contactState.id })
      .from(contactState)
      .where(eq(contactState.contactId, CONTACT_ID)),
    db
      .select({ id: stateTransition.id })
      .from(stateTransition)
      .where(eq(stateTransition.contactId, CONTACT_ID)),
    db
      .select({ id: nextAction.id })
      .from(nextAction)
      .where(eq(nextAction.contactId, CONTACT_ID)),
    db
      .select({ id: sideEffectIntent.id })
      .from(sideEffectIntent)
      .where(eq(sideEffectIntent.contactId, CONTACT_ID)),
    db
      .select({ id: contactLink.id })
      .from(contactLink)
      .where(eq(contactLink.contactId, CONTACT_ID)),
    db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.id, PURCHASE_ID)),
    db
      .select({ id: googleAdsConversionUpload.id })
      .from(googleAdsConversionUpload)
      .where(eq(googleAdsConversionUpload.purchaseId, PURCHASE_ID)),
  ]);

  return {
    users: userRows.length,
    contacts: contactRows.length,
    providerIdentities: identityRows.length,
    contactEvents: eventRows.length,
    contactStates: stateRows.length,
    stateTransitions: transitionRows.length,
    nextActions: nextActionRows.length,
    sideEffectIntents: intentRows.length,
    contactLinks: linkRows.length,
    purchases: purchaseRows.length,
    purchaseConversionLedger: ledgerRows.length,
  };
}

function readbackIsEmpty(readback: CleanupReadback) {
  return Object.values(readback).every((count) => count === 0);
}

async function cleanupFixture() {
  await db
    .delete(googleAdsConversionUpload)
    .where(eq(googleAdsConversionUpload.purchaseId, PURCHASE_ID));
  await db.delete(purchases).where(eq(purchases.id, PURCHASE_ID));
  await db
    .delete(sideEffectIntent)
    .where(eq(sideEffectIntent.contactId, CONTACT_ID));
  await db.delete(nextAction).where(eq(nextAction.contactId, CONTACT_ID));
  await db
    .delete(stateTransition)
    .where(eq(stateTransition.contactId, CONTACT_ID));
  await db.delete(contactState).where(eq(contactState.contactId, CONTACT_ID));
  await db
    .delete(contactEvent)
    .where(eq(contactEvent.providerEventId, PROVIDER_EVENT_ID));
  await db
    .delete(providerIdentity)
    .where(
      and(
        eq(providerIdentity.provider, "kit"),
        eq(providerIdentity.externalId, KIT_SUBSCRIBER_ID),
      ),
    );
  await db.delete(contactLink).where(eq(contactLink.contactId, CONTACT_ID));
  await db.delete(contact).where(eq(contact.id, CONTACT_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  return readbackFixtureRows();
}

async function runCandidateScan() {
  return processGoogleAdsConversionUploads({
    database: db,
    config: readGoogleAdsConversionUploadConfig({ enabled: false }),
    uploadClient: noGoogleWriteClient,
    purchaseId: PURCHASE_ID,
    limit: 1,
    dryRun: true,
  });
}

async function run() {
  const argv = process.argv.slice(2);
  if (!hasFlag(argv, "--allow-write")) {
    throw new Error(
      "Synthetic proof fixture writes require explicit --allow-write",
    );
  }

  if (hasFlag(argv, "--cleanup")) {
    const cleanupReadback = await cleanupFixture();
    console.log(
      JSON.stringify(
        {
          mode: "cleanup",
          fixtureNamespace: FIXTURE_NAMESPACE,
          cleanupVerified: readbackIsEmpty(cleanupReadback),
          postDeleteReadback: cleanupReadback,
        },
        null,
        2,
      ),
    );
    if (!readbackIsEmpty(cleanupReadback)) process.exitCode = 1;
    return;
  }

  const receiptPath = readFlag(argv, "--receipt") ?? DEFAULT_RECEIPT_PATH;
  const startedAt = new Date();
  const purchaseAt = new Date(startedAt.getTime() + 1_000);
  const recentClickAt = new Date(purchaseAt.getTime() - 60 * 60 * 1000);
  const expiredClickAt = new Date(
    purchaseAt.getTime() - 91 * 24 * 60 * 60 * 1000,
  );
  const assertions: AssertionReceipt[] = [];
  let failure: string | null = null;
  let fixtureCounts: Record<string, number> = {};
  let postDeleteReadback: CleanupReadback = {};

  const recordAssertion = (
    name: string,
    passed: boolean,
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
  ) => {
    assertions.push({ name, passed, expected, actual });
  };

  try {
    const before = await readbackFixtureRows();
    if (!readbackIsEmpty(before)) {
      throw new Error(
        "Fixture debris already exists; run this script with --cleanup --allow-write before retrying",
      );
    }
    const product = await db.query.products.findFirst({
      where: eq(products.status, 1),
    });
    if (!product)
      throw new Error(
        "No active product is available for the fixture purchase",
      );

    await db.insert(users).values({
      id: USER_ID,
      name: "AI Hero Purchase Fallback Synthetic Proof",
      email: FIXTURE_EMAIL,
      emailVerified: startedAt,
      fields: { syntheticProof: FIXTURE_NAMESPACE },
    });

    const repository = new SyntheticProofCaptureRepository(db);
    const capture = await captureNormalizedContactEvent({
      repository,
      now: startedAt.toISOString(),
      event: normalizeContactEvent({
        provider: "kit",
        providerEventId: PROVIDER_EVENT_ID,
        eventType: "skills-newsletter.subscribed",
        occurredAt: startedAt.toISOString(),
        email: FIXTURE_EMAIL,
        name: "AI Hero Purchase Fallback Synthetic Proof",
        userId: USER_ID,
        externalId: KIT_SUBSCRIBER_ID,
        message:
          "Synthetic signup fixture for purchase fallback resolution proof.",
        privacyLevel: "internal",
        optInAttribution: {
          gclid: FORMAT_VALID_SYNTHETIC_GCLID,
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "synthetic-purchase-fallback-proof",
          landingPath: "/synthetic-purchase-fallback-proof",
          capturedAt: recentClickAt.toISOString(),
          subscribedAt: startedAt.toISOString(),
        },
      }),
    });
    if (capture.contact.id !== CONTACT_ID) {
      throw new Error(
        "Synthetic capture did not use the expected namespaced contact id",
      );
    }

    await db.insert(purchases).values({
      id: PURCHASE_ID,
      userId: USER_ID,
      productId: product.id,
      totalAmount: "1.00",
      status: "Valid",
      createdAt: purchaseAt,
      fields: {
        syntheticProof: FIXTURE_NAMESPACE,
        attribution: {
          kitSubscriberId: JSON.stringify(KIT_SUBSCRIBER_ID),
        },
      },
    });

    const createdRows = await readbackFixtureRows();
    fixtureCounts = createdRows;
    recordAssertion(
      "fixture-created-through-real-signup-capture-path",
      createdRows.users === 1 &&
        createdRows.contacts === 1 &&
        createdRows.providerIdentities === 1 &&
        createdRows.contactEvents === 1 &&
        createdRows.contactStates === 1 &&
        createdRows.purchases === 1,
      {
        users: 1,
        contacts: 1,
        providerIdentities: 1,
        contactEvents: 1,
        contactStates: 1,
        purchases: 1,
      },
      createdRows,
    );

    const emailSummary = await runCandidateScan();
    recordAssertion(
      "buyer-email-resolves-contact-signup-gclid",
      matchingHappyPathSummary(emailSummary, "buyer-email"),
      {
        fallbackResolved: 1,
        fallbackResolution: "buyer-email",
        attributionSource: "signup-gclid-fallback",
        dryRunEligible: 1,
        uploaded: 0,
      },
      summarySnapshot(emailSummary),
    );

    await db
      .update(users)
      .set({ email: ALTERED_BUYER_EMAIL })
      .where(eq(users.id, USER_ID));
    const kitSummary = await runCandidateScan();
    recordAssertion(
      "kit-subscriber-id-resolves-provider-identity-signup-gclid",
      matchingHappyPathSummary(kitSummary, "kit-provider-identity"),
      {
        fallbackResolved: 1,
        fallbackResolution: "kit-provider-identity",
        attributionSource: "signup-gclid-fallback",
        dryRunEligible: 1,
        uploaded: 0,
      },
      summarySnapshot(kitSummary),
    );

    recordAssertion(
      "recent-click-passes-90-day-window",
      isClickWithinGoogleUploadWindow({
        clickAt: recentClickAt,
        conversionAt: purchaseAt,
      }),
      { within90Days: true },
      { within90Days: true, ageDays: 1 / 24 },
    );

    await db
      .update(contactState)
      .set({
        optInAttribution: {
          gclid: FORMAT_VALID_SYNTHETIC_GCLID,
          capturedAt: expiredClickAt.toISOString(),
          subscribedAt: startedAt.toISOString(),
        },
      })
      .where(eq(contactState.contactId, CONTACT_ID));
    const expiredSummary = await runCandidateScan();
    recordAssertion(
      "expired-click-rejected-outside-90-day-window",
      !isClickWithinGoogleUploadWindow({
        clickAt: expiredClickAt,
        conversionAt: purchaseAt,
      }) &&
        matchingGuardSummary(
          expiredSummary,
          "signup-gclid-outside-90-day-window",
        ),
      {
        within90Days: false,
        reason: "signup-gclid-outside-90-day-window",
        dryRunEligible: 0,
      },
      {
        within90Days: false,
        ageDays: 91,
        ...summarySnapshot(expiredSummary),
      },
    );

    await db
      .update(contactState)
      .set({
        optInAttribution: {
          gclid: TEST_GCLID,
          capturedAt: recentClickAt.toISOString(),
          subscribedAt: startedAt.toISOString(),
        },
      })
      .where(eq(contactState.contactId, CONTACT_ID));
    const storedSyntheticSummary = await runCandidateScan();
    recordAssertion(
      "test-prefixed-stored-signup-click-id-blocks-upload-eligibility",
      matchingGuardSummary(
        storedSyntheticSummary,
        "fallback-real-gclid-signup-not-found",
      ),
      {
        reason: "fallback-real-gclid-signup-not-found",
        dryRunEligible: 0,
        uploaded: 0,
      },
      summarySnapshot(storedSyntheticSummary),
    );

    await db
      .update(purchases)
      .set({
        fields: {
          syntheticProof: FIXTURE_NAMESPACE,
          attribution: {
            synthetic: true,
            kitSubscriberId: JSON.stringify(KIT_SUBSCRIBER_ID),
            clickIds: { gclid: TEST_GCLID },
          },
        },
      })
      .where(eq(purchases.id, PURCHASE_ID));
    const checkoutSyntheticSummary = await runCandidateScan();
    recordAssertion(
      "test-prefixed-checkout-click-id-blocks-upload-eligibility",
      matchingGuardSummary(
        checkoutSyntheticSummary,
        "synthetic-google-click-id",
      ),
      {
        reason: "synthetic-google-click-id",
        dryRunEligible: 0,
        uploaded: 0,
      },
      summarySnapshot(checkoutSyntheticSummary),
    );

    const ledgerBeforeCleanup = await db
      .select({ id: googleAdsConversionUpload.id })
      .from(googleAdsConversionUpload)
      .where(eq(googleAdsConversionUpload.purchaseId, PURCHASE_ID));
    recordAssertion(
      "real-candidate-scans-created-no-ledger-and-made-no-google-writes",
      ledgerBeforeCleanup.length === 0 && googleUploadAttempts === 0,
      { purchaseConversionLedger: 0, googleUploadAttempts: 0 },
      {
        purchaseConversionLedger: ledgerBeforeCleanup.length,
        googleUploadAttempts,
      },
    );

    const failedAssertions = assertions.filter(
      (assertion) => !assertion.passed,
    );
    if (failedAssertions.length > 0) {
      throw new Error(
        `${failedAssertions.length} synthetic proof assertion(s) failed`,
      );
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    postDeleteReadback = await cleanupFixture();
    recordAssertion(
      "fixture-cleanup-post-delete-readbacks-are-empty",
      readbackIsEmpty(postDeleteReadback),
      Object.fromEntries(
        Object.keys(postDeleteReadback).map((table) => [table, 0]),
      ),
      postDeleteReadback,
    );
  }

  const cleanupVerified = readbackIsEmpty(postDeleteReadback);
  const allAssertionsPassed = assertions.every((assertion) => assertion.passed);
  const receipt = {
    version: 1,
    task: "purchase-attribution-fallback-synthetic-proof",
    fixtureNamespace: FIXTURE_NAMESPACE,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    writesPerformed: true,
    productionCandidateScan: {
      mode: "dry-run",
      googleApiWritesAllowed: false,
      fixturePurchaseFilterApplied: true,
    },
    fixtureCounts,
    assertions,
    cleanup: {
      verified: cleanupVerified,
      postDeleteReadback,
    },
    failure,
    privacy:
      "aggregate-only-no-emails-no-contact-ids-no-purchase-ids-no-provider-ids-no-raw-click-ids",
    notes: [
      "The fixture signup used the real normalized Contact capture path and a Kit provider identity.",
      "The purchase candidate scans used the production database query and fallback resolver with dryRun=true and uploads disabled.",
      "The main synthetic gclid is format-valid and obviously synthetic but does not use the TEST_ prefix reserved for the uploader guard assertion.",
      "Every fixture table is read back after cleanup; all counts must be zero.",
    ],
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2));

  if (failure || !cleanupVerified || !allAssertionsPassed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
