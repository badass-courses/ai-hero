import { createHash } from "node:crypto";
import { Effect } from "effect";
import { createActor, setup } from "xstate";
import { z } from "zod";
import type {
  createBoundedJourneyReaders,
  ScanCursor,
} from "./bounded-readers";
import type { createCouponIntentExecutor } from "./coupon-executor";
import type { createRevisionDelivery } from "./revision-delivery";
import type { EvergreenOfferJourneyService, JourneyClock } from "./ports";
import type { createVerifiedUserObservedReader } from "./verified-user-observed-source";

/** Accepted reader type; never inferred auth/session facts. */
export type BridgeClaimSource = ReturnType<
  typeof createVerifiedUserObservedReader
>;
import { parseStimulusId } from "./primitives";

export const runtimeLanes = ["source", "wakes", "intents"] as const;
const cursor = z
  .object({
    at: z.string().datetime({ precision: 3 }),
    id: z.string().min(1).max(500),
  })
  .strict();
export const bridgeTickRequestSchema = z
  .object({
    generation: z.string().min(1).max(100),
    lane: z.enum(runtimeLanes),
    after: cursor.optional(),
  })
  .strict();
export type BridgeTickRequest = z.infer<typeof bridgeTickRequestSchema>;
export type BridgeControl =
  | { type: "Disabled" }
  | { type: "Unavailable"; reason: string }
  | { type: "Enabled"; generation: string };
export type BridgeTickResult = {
  type: "Disabled" | "Unavailable" | "Stale" | "Busy" | "Paused" | "Progress";
  reason: string;
  scanned: number;
  /** Persist only after observing this result; end-of-range restarts from origin. */
  continuation: BridgeTickRequest;
};

const lifecycle = setup({
  types: { events: {} as { type: "START" | "DONE" | "PAUSE" | "FAIL" } },
}).createMachine({
  initial: "idle",
  states: {
    idle: { on: { START: "running" } },
    running: { on: { DONE: "idle", PAUSE: "paused", FAIL: "unavailable" } },
    paused: { on: { START: "running" } },
    unavailable: { on: { START: "running" } },
  },
});

type Readers = ReturnType<typeof createBoundedJourneyReaders>;
type Messages = ReturnType<typeof createRevisionDelivery>;
type Coupons = ReturnType<typeof createCouponIntentExecutor>;
export type BridgeRuntimeDependencies = {
  clock: JourneyClock;
  /** Shared durable control must be read fresh, never a captured environment boolean. */
  control: () => Effect.Effect<BridgeControl, unknown>;
  readers: Readers;
  service: Pick<EvergreenOfferJourneyService, "advance">;
  messages: Messages;
  coupons: Coupons;
  claimSource?: BridgeClaimSource;
};

/** One candidate per invocation; no cron, provider client, default DB or registration.
 * Caller owns durable continuation and pacing. Read cursors do not claim work.
 * Cross-process races are arbitrated by the existing ledger and durable attempts.
 */
export function createBridgeRuntime(dependencies: BridgeRuntimeDependencies) {
  const d = { ...dependencies };
  const actor = createActor(lifecycle).start();
  let lastResult: { type: string; reason: string } | null = null;
  const status = () => ({
    type: "RuntimeStatus" as const,
    lifecycle: actor.getSnapshot().value,
    minimumIntervalMs: 1000,
    pageLimit: 1,
    lastResult: lastResult ? { ...lastResult } : null,
    newsletterOwnership: "ExternalContinuity" as const,
  });
  const tick = (input: BridgeTickRequest): Effect.Effect<BridgeTickResult> =>
    Effect.gen(function* () {
      const parsed = bridgeTickRequestSchema.safeParse(input);
      // No cursor is silently repaired; invalid requests never reach a reader.
      if (!parsed.success)
        return {
          type: "Unavailable",
          reason: "InvalidRequest",
          scanned: 0,
          continuation: input,
        } as const;
      const request = parsed.data;
      const answer = (
        type: BridgeTickResult["type"],
        reason: string,
        scanned = 0,
        next: ScanCursor | null = request.after ?? null,
      ): BridgeTickResult => ({
        type,
        reason,
        scanned,
        continuation: {
          generation: request.generation,
          lane: request.lane,
          ...(next ? { after: next } : {}),
        },
      });
      if (actor.getSnapshot().matches("running"))
        return answer("Busy", "TickInFlight");
      actor.send({ type: "START" });
      const work = Effect.gen(function* () {
        const gate = yield* d.control();
        if (gate.type === "Disabled")
          return answer("Disabled", "ControlDisabled");
        if (gate.type === "Unavailable")
          return answer("Unavailable", "ControlUnavailable");
        if (gate.generation !== request.generation)
          return answer("Stale", "ControlGenerationChanged");
        const now = new Date(yield* d.clock.now);
        if (!Number.isFinite(now.getTime()))
          return answer("Unavailable", "ClockInvalid");
        // Every page is one row so a failure never skips unprocessed candidates.
        const pageInput = {
          now,
          limit: 1,
          ...(request.after ? { after: request.after } : {}),
        };
        if (
          request.lane === "source" ||
          request.lane === "wakes" ||
          request.lane === "intents"
        ) {
          const page = yield* d.readers[request.lane](pageInput);
          const next = page.end ? null : page.nextCursor;
          if (page.held.length)
            return answer("Paused", page.held[0]!.reason, page.scanned, next);
          const candidate = page.candidates[0];
          if (!candidate)
            return answer("Progress", "RangeComplete", page.scanned, next);
          // Control can change during scan. Preserve the cursor when work did not run.
          const fresh = yield* d.control();
          if (
            fresh.type !== "Enabled" ||
            fresh.generation !== request.generation
          )
            return answer("Paused", "ControlChanged");
          if ("entryFactId" in candidate) {
            yield* d.service.advance(candidate);
            return answer("Progress", "SourceFolded", page.scanned, next);
          }
          if ("wakeId" in candidate) {
            const id = parseStimulusId(
              `bridge-wake:${createHash("sha256").update(candidate.wakeId).digest("hex")}`,
            );
            if (!id.ok) return answer("Unavailable", "WakeIdentityInvalid");
            yield* d.service.advance({
              type: "WakeDue",
              stimulusId: id.value,
              journeyId: candidate.journeyId,
              wakeId: candidate.wakeId,
              dueAt: candidate.dueAt,
              purpose: candidate.purpose,
            });
            return answer("Progress", "WakeFolded", page.scanned, next);
          }
          const target = {
            journeyId: candidate.intent.journeyId,
            idempotencyKey: candidate.intent.idempotencyKey,
          };
          if (candidate.intent.type === "SendMessage") {
            const result = yield* d.messages.execute(target);
            const ok =
              result.type === "Applied" &&
              (result.settlement.type === "Committed" ||
                result.settlement.type === "AlreadyCommitted");
            return answer(
              ok ? "Progress" : "Paused",
              `Message:${result.type}`,
              page.scanned,
              next,
            );
          }
          if (
            candidate.intent.type === "IssueCoupon" ||
            candidate.intent.type === "BindCoupon"
          ) {
            const result = yield* d.coupons.execute(target);
            return answer(
              result.type === "Committed" || result.type === "AlreadyCommitted"
                ? "Progress"
                : "Paused",
              `Coupon:${result.type}`,
              page.scanned,
              next,
            );
          }
          // Existing signup handoff is not an at-most-one-request audience executor.
          // Never turn its backfill tag, current membership or retries into a receipt.
          return answer(
            "Paused",
            "ShadowHandoffExecutorUnavailable",
            page.scanned,
            next,
          );
        }
        return answer("Unavailable", "InvalidLane");
      });
      const result = yield* work.pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(answer("Unavailable", "RuntimeDependencyUnavailable")),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            lastResult = { type: "Unavailable", reason: "TickInterrupted" };
            actor.send({ type: "FAIL" });
          }),
        ),
      );
      lastResult = { type: result.type, reason: result.reason };
      actor.send({
        type:
          result.type === "Unavailable"
            ? "FAIL"
            : result.type === "Paused"
              ? "PAUSE"
              : "DONE",
      });
      return result;
    });
  function recover<A, E>(generation: string, work: () => Effect.Effect<A, E>) {
    return Effect.gen(function* () {
      if (actor.getSnapshot().matches("running"))
        return { type: "Held" as const, reason: "TickInFlight" };
      actor.send({ type: "START" });
      const result = yield* Effect.gen(function* () {
        const gate = yield* d.control();
        if (gate.type !== "Enabled" || gate.generation !== generation)
          return {
            type: "Held" as const,
            reason: "ControlUnavailableOrChanged",
          };
        return { type: "RecoveryPage" as const, page: yield* work() };
      }).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed({
            type: "Held" as const,
            reason: "RecoveryUnavailable",
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            lastResult = { type: "Unavailable", reason: "RecoveryInterrupted" };
            actor.send({ type: "FAIL" });
          }),
        ),
      );
      lastResult = {
        type: result.type,
        reason:
          result.type === "Held"
            ? result.reason
            : "RecoveryPageRequiresInspection",
      };
      // A page can contain an unresolved outcome. Never project page-read success
      // as healthy execution; caller must inspect results and persist exact cursors.
      actor.send({ type: "PAUSE" });
      return result;
    });
  }
  return {
    tick,
    status,
    claimSource: (generation: string, input: { after?: string }) =>
      recover(generation, () =>
        Effect.gen(function* () {
          if (!d.claimSource)
            return {
              type: "Unavailable" as const,
              reason: "ClaimSourceUnconfigured",
            };
          if (
            !z
              .object({ after: z.string().min(1).max(500).optional() })
              .strict()
              .safeParse(input).success
          )
            return {
              type: "Unavailable" as const,
              reason: "InvalidClaimCursor",
            };
          const page = yield* Effect.tryPromise(() =>
            d.claimSource!.page({ ...input, limit: 1 }),
          );
          const scanned = page.candidates.length + page.held.length;
          if (scanned > 1)
            return {
              type: "Unavailable" as const,
              reason: "ClaimReaderExceededBound",
            };
          if (page.held.length)
            return {
              type: "Held" as const,
              reason: "InvalidClaimSource",
              cursor: page.cursor,
              scanned,
            };
          const candidate = page.candidates[0];
          if (candidate) {
            const gate = yield* d.control();
            if (gate.type !== "Enabled" || gate.generation !== generation)
              return {
                type: "Held" as const,
                reason: "ControlChanged",
                cursor: input.after ?? null,
                scanned: 0,
              };
            yield* d.service.advance(candidate);
          }
          return {
            type: "Scanned" as const,
            cursor: scanned ? page.cursor : null,
            scanned,
          };
        }),
      ),
    messageRecorded: (
      generation: string,
      input: Omit<Parameters<Messages["settleRecordedOutcomes"]>[0], "limit">,
    ) =>
      recover(generation, () =>
        d.messages.settleRecordedOutcomes({ ...input, limit: 1 }),
      ),
    messageUncertain: (
      generation: string,
      input: Omit<Parameters<Messages["reconcileHeld"]>[0], "limit">,
    ) =>
      recover(generation, () =>
        d.messages.reconcileHeld({ ...input, limit: 1 }),
      ),
    couponRecorded: (
      generation: string,
      input: Omit<
        Parameters<Coupons["recoverRecordedPage"]>[0],
        "limit" | "now"
      >,
    ) =>
      recover(generation, () =>
        Effect.gen(function* () {
          const now = new Date(yield* d.clock.now);
          return yield* d.coupons.recoverRecordedPage({
            ...input,
            now,
            limit: 1,
          });
        }),
      ),
    couponUncertain: (
      generation: string,
      input: Omit<
        Parameters<Coupons["recoverUncertainPage"]>[0],
        "limit" | "now"
      >,
    ) =>
      recover(generation, () =>
        Effect.gen(function* () {
          const now = new Date(yield* d.clock.now);
          return yield* d.coupons.recoverUncertainPage({
            ...input,
            now,
            limit: 1,
          });
        }),
      ),
  };
}
