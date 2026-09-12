import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DetectorEvent } from "../contracts/index";

export const CORE_TARGETS = new Set<DetectorEvent["target"]>([
  "web",
  "auth",
  "checkout",
  "content",
  "database",
]);

export type SuppressionRule = {
  id: string;
  detectorId: string;
  target: DetectorEvent["target"];
  signalCode: string;
  startsAt: string;
  expiresAt: string;
  owner: string;
};

export const TRACER_POLICY = {
  version: "aih.status.policy.tracer.v1",
  windowMs: 5 * 60 * 1000,
  degradedFailures: 2,
  outageFailures: 3,
  samples: 3,
  proposalTtlMs: 15 * 60 * 1000,
  fakeInvestigationAcuMax: 1,
  fakeInvestigationHourlyCap: 5,
  suppressions: [
    {
      id: "launch-shadow-newsletter-paused-v1",
      detectorId: "ai-hero-skills-newsletter-path-entry-v2",
      target: "learner_flow",
      signalCode: "subscribe_to_shadow_newsletter_sequence_paused",
      startsAt: "2026-08-07T00:00:00.000Z",
      expiresAt: "2026-08-25T23:59:59.999Z",
      owner: "ai-hero-launch-2026-08",
    },
  ] satisfies SuppressionRule[],
} as const;

const timestamp = (value: string): number => Date.parse(value);

export function findSuppression(event: DetectorEvent): SuppressionRule | undefined {
  const observedAt = timestamp(event.observedAt);
  return TRACER_POLICY.suppressions.find(
    (rule) =>
      rule.detectorId === event.detectorId &&
      rule.target === event.target &&
      rule.signalCode === event.signal.code &&
      observedAt >= timestamp(rule.startsAt) &&
      observedAt <= timestamp(rule.expiresAt),
  );
}

export function eventsInWindow(events: readonly DetectorEvent[], now: string): DetectorEvent[] {
  const end = timestamp(now);
  const start = end - TRACER_POLICY.windowMs;
  return events
    .filter((event) => {
      const observed = timestamp(event.observedAt);
      return observed >= start && observed <= end;
    })
    .sort((left, right) => timestamp(left.observedAt) - timestamp(right.observedAt));
}

export function classifyFailure(
  events: readonly DetectorEvent[],
  now: string,
): "none" | "degraded" | "outage" {
  const latest = eventsInWindow(events, now).slice(-TRACER_POLICY.samples);
  const failures = latest.filter((event) => event.signal.state === "fail");
  if (failures.length === 0) return "none";

  const sameCoreFailures = failures.filter(
    (event) =>
      CORE_TARGETS.has(event.target) &&
      event.target === failures[0]?.target &&
      event.signal.code === failures[0]?.signal.code,
  );
  const independentFamilyAgreement = sameCoreFailures.some((left, index) =>
    sameCoreFailures
      .slice(index + 1)
      .some(
        (right) => left.detectorKind !== right.detectorKind && left.detectorId !== right.detectorId,
      ),
  );
  if (failures.length >= TRACER_POLICY.outageFailures || independentFamilyAgreement) {
    return "outage";
  }
  if (failures.length >= TRACER_POLICY.degradedFailures) return "degraded";
  return "none";
}

export function hasProposalAgreement(events: readonly DetectorEvent[], now: string): boolean {
  const detectorIds = new Set(
    eventsInWindow(events, now)
      .filter((event) => event.signal.state === "fail")
      .map((event) => event.detectorId),
  );
  return detectorIds.size >= 2;
}

export function evaluateRecovery(
  events: readonly DetectorEvent[],
  openingFamilies: readonly DetectorEvent["detectorKind"][],
  openingDetectorIds: readonly string[],
): { entry: boolean; resolved: boolean } {
  const sorted = [...events].sort(
    (left, right) => timestamp(left.observedAt) - timestamp(right.observedAt),
  );
  const familySamples = openingFamilies.map((family) =>
    sorted.filter((event) => event.detectorKind === family).slice(-3),
  );
  const entry = familySamples.every(
    (samples) =>
      samples.length >= 2 && samples.slice(-2).every((event) => event.signal.state === "pass"),
  );
  if (!entry) return { entry: false, resolved: false };

  const threePassesPerFamily = familySamples.every(
    (samples) => samples.length >= 3 && samples.every((event) => event.signal.state === "pass"),
  );
  const openingPasses = familySamples.flat();
  const passTimes = openingPasses.map((event) => timestamp(event.observedAt));
  const range = passTimes.length === 0 ? 0 : Math.max(...passTimes) - Math.min(...passTimes);
  const independentCorePass = sorted.some(
    (event) =>
      event.signal.state === "pass" &&
      CORE_TARGETS.has(event.target) &&
      !openingDetectorIds.includes(event.detectorId),
  );

  return {
    entry: true,
    resolved: threePassesPerFamily && range >= TRACER_POLICY.windowMs && independentCorePass,
  };
}

export function correlationBase(event: DetectorEvent): string {
  const fifteenMinuteBucket = Math.floor(timestamp(event.observedAt) / (15 * 60 * 1000));
  return stableDigest(
    `${TRACER_POLICY.version}:${event.target}:${event.signal.code}:${fifteenMinuteBucket}`,
  );
}

export function stableDigest(input: string): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(input)))}`;
}
