import { Effect, Fiber, Deferred } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createBridgeRuntime,
  type BridgeRuntimeDependencies,
  type BridgeControl,
} from "./bridge-runtime";
import { inspectBridgeConfiguration } from "./bridge-composition";
import {
  createBoundedJourneyReaders,
  restoreSourceCandidate,
} from "./bounded-readers";
import { currentCourseSourceFixture } from "./bounded-readers.fixtures";
import { makeInMemoryJourneyLedger } from "./in-memory-ledger";
import { createEvergreenOfferJourneyService } from "./service";
import { EVERGREEN_OFFER_JOURNEY_V2 } from "./definition";
import { parseIsoInstant, deriveJourneyId } from "./primitives";

function harness() {
  const source = currentCourseSourceFixture();
  const entry = restoreSourceCandidate(source)!;
  const ledger = makeInMemoryJourneyLedger();
  const parsed = parseIsoInstant(entry.exhaustedAt);
  if (!parsed.ok) throw new Error("bad fixture");
  const at = parsed.value;
  let gate: BridgeControl = { type: "Enabled", generation: "test-v1" };
  const clock = { now: Effect.succeed(at) };
  const service = createEvergreenOfferJourneyService({
    ledger,
    clock,
    definition: EVERGREEN_OFFER_JOURNEY_V2,
    authority: {
      currentFacts: ({ journeyId }) =>
        Effect.succeed({
          contactId: entry.contactId,
          purchase: null,
          delivery: { type: "Eligible" },
          existingJourneyId: journeyId,
          automationControl: { type: "Enabled", version: "test-v1" },
          evidenceVersion: "fixture",
          readAt: at,
        }),
    },
  });
  let rows: unknown[] = [source];
  const limit = vi.fn(async () => rows);
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
    }),
  } as unknown as Parameters<typeof createBoundedJourneyReaders>[0];
  const messages = {
    execute: vi.fn(),
    settleRecordedOutcomes: vi.fn(() =>
      Effect.succeed({ type: "Held", reason: "test" }),
    ),
    reconcileHeld: vi.fn(() =>
      Effect.succeed({ type: "Held", reason: "test" }),
    ),
  } as unknown as BridgeRuntimeDependencies["messages"];
  const coupons = {
    execute: vi.fn(),
    recoverRecordedPage: vi.fn(),
    recoverUncertainPage: vi.fn(),
  } as unknown as BridgeRuntimeDependencies["coupons"];
  const dependencies = {
    clock,
    ledger,
    service,
    readers: createBoundedJourneyReaders(db, ledger),
    messages,
    coupons,
    control: () => Effect.succeed(gate),
  };
  return {
    entry,
    ledger,
    limit,
    messages,
    dependencies,
    setRows: (value: unknown[]) => {
      rows = value;
    },
    setGate: (value: BridgeControl) => {
      gate = value;
    },
  };
}
const request = { generation: "test-v1", lane: "source" as const };
describe("bounded bridge runtime", () => {
  it("folds a real source codec through the real service/ledger with V2 and survives restart/duplicate", async () => {
    const h = harness();
    const first = createBridgeRuntime(h.dependencies);
    expect(await Effect.runPromise(first.tick(request))).toMatchObject({
      type: "Progress",
      reason: "SourceFolded",
      scanned: 1,
    });
    const before = await Effect.runPromise(
      h.ledger.findCommittedStimulus(h.entry.stimulusId),
    );
    expect(before).not.toBeNull();
    const restored = createBridgeRuntime(h.dependencies);
    await Effect.runPromise(restored.tick(request));
    expect(
      await Effect.runPromise(
        h.ledger.findCommittedStimulus(h.entry.stimulusId),
      ),
    ).toEqual(before);
    expect(h.limit).toHaveBeenCalledWith(1);
    expect(h.messages.execute).not.toHaveBeenCalled();
    const id = deriveJourneyId(h.entry.entryFactId);
    const state = await Effect.runPromise(h.ledger.load(id));
    expect(state?.definition.definitionVersion).toBe("evergreen-offer-v2");
    expect(state?.messagePlan.bridge).toHaveLength(3);
  });
  it("does not scan when disabled, unavailable or stale; status is read-only", async () => {
    const h = harness();
    const runtime = createBridgeRuntime(h.dependencies);
    expect(runtime.status().lifecycle).toBe("idle");
    h.setGate({ type: "Disabled" });
    expect((await Effect.runPromise(runtime.tick(request))).type).toBe(
      "Disabled",
    );
    h.setGate({ type: "Unavailable", reason: "db-down" });
    expect((await Effect.runPromise(runtime.tick(request))).type).toBe(
      "Unavailable",
    );
    h.setGate({ type: "Enabled", generation: "new" });
    expect((await Effect.runPromise(runtime.tick(request))).type).toBe("Stale");
    expect(h.limit).not.toHaveBeenCalled();
  });
  it("advances past poison without fabricating a source and can process the next page", async () => {
    const h = harness();
    const runtime = createBridgeRuntime(h.dependencies);
    const bad = { ...currentCourseSourceFixture(), provider: "kit" };
    h.setRows([bad]);
    const held = await Effect.runPromise(runtime.tick(request));
    expect(held).toMatchObject({
      type: "Paused",
      reason: "InvalidSource",
      scanned: 1,
    });
    expect(held.continuation.after?.id).toBe(bad.id);
    expect(
      await Effect.runPromise(
        h.ledger.findCommittedStimulus(h.entry.stimulusId),
      ),
    ).toBeNull();
    h.setRows([currentCourseSourceFixture()]);
    expect(
      (await Effect.runPromise(runtime.tick(held.continuation))).type,
    ).toBe("Progress");
  });
  it("preserves position when control changes while source scan is in flight", async () => {
    const h = harness();
    const runtime = createBridgeRuntime(h.dependencies);
    h.limit.mockImplementationOnce(async () => {
      h.setGate({ type: "Disabled" });
      return [currentCourseSourceFixture()];
    });
    expect(await Effect.runPromise(runtime.tick(request))).toMatchObject({
      type: "Paused",
      reason: "ControlChanged",
      continuation: request,
    });
    expect(
      await Effect.runPromise(
        h.ledger.findCommittedStimulus(h.entry.stimulusId),
      ),
    ).toBeNull();
  });
  it("serializes racing local ticks and retains durable dedupe for another process", async () => {
    const h = harness();
    const runtime = createBridgeRuntime(h.dependencies);
    const results = await Promise.all([
      Effect.runPromise(runtime.tick(request)),
      Effect.runPromise(runtime.tick(request)),
    ]);
    expect(results.map((r) => r.type)).toContain("Busy");
    expect(results.map((r) => r.type)).toContain("Progress");
  });
  it("fails unavailable without leaking database errors or moving cursor", async () => {
    const h = harness();
    h.limit.mockRejectedValueOnce(new Error("private connection detail"));
    const runtime = createBridgeRuntime(h.dependencies);
    expect(await Effect.runPromise(runtime.tick(request))).toEqual({
      type: "Unavailable",
      reason: "RuntimeDependencyUnavailable",
      scanned: 0,
      continuation: request,
    });
  });
  it("reports external continuity and advances held audience work without any provider dispatch", async () => {
    const h = harness();
    const candidate = {
      intent: {
        type: "EnterShadowNewsletter",
        journeyId: deriveJourneyId(h.entry.entryFactId),
        contactId: h.entry.contactId,
        idempotencyKey: "fixture-audience",
      },
    } as unknown as Awaited<
      Effect.Effect.Success<
        ReturnType<BridgeRuntimeDependencies["readers"]["intents"]>
      >
    >["candidates"][number];
    const page = vi.fn(() =>
      Effect.succeed({
        candidates: [candidate],
        held: [],
        scanned: 1,
        nextCursor: { at: h.entry.exhaustedAt, id: "fixture-audience" },
        end: false,
      }),
    );
    const runtime = createBridgeRuntime({
      ...h.dependencies,
      readers: { ...h.dependencies.readers, intents: page },
    });
    const held = await Effect.runPromise(
      runtime.tick({ generation: "test-v1", lane: "intents" }),
    );
    expect(held).toMatchObject({
      type: "Paused",
      reason: "ShadowHandoffExecutorUnavailable",
      continuation: { after: { id: "fixture-audience" } },
    });
    expect(runtime.status()).toMatchObject({
      lifecycle: "paused",
      newsletterOwnership: "ExternalContinuity",
      lastResult: { reason: "ShadowHandoffExecutorUnavailable" },
    });
    expect(page).toHaveBeenCalledTimes(1); // no internal retry/spin
    expect(h.messages.execute).not.toHaveBeenCalled();
    expect(h.dependencies.coupons.execute).not.toHaveBeenCalled();
    // A later supported lane proceeds; expected external hold is not a global stop.
    expect((await Effect.runPromise(runtime.tick(request))).reason).toBe(
      "SourceFolded",
    );
  });
  it("interruption releases the local lifecycle while another busy caller cannot release its owner", async () => {
    const h = harness();
    const entered = await Effect.runPromise(Deferred.make<void>());
    let waiting = true;
    const runtime = createBridgeRuntime({
      ...h.dependencies,
      control: () =>
        waiting
          ? Effect.zipRight(Deferred.succeed(entered, undefined), Effect.never)
          : Effect.succeed({ type: "Disabled" }),
    });
    const fiber = Effect.runFork(runtime.tick(request));
    await Effect.runPromise(Deferred.await(entered));
    expect((await Effect.runPromise(runtime.tick(request))).type).toBe("Busy");
    expect(runtime.status().lifecycle).toBe("running");
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(runtime.status().lifecycle).toBe("unavailable");
    waiting = false;
    expect((await Effect.runPromise(runtime.tick(request))).type).toBe(
      "Disabled",
    );
  });
  it("keeps default-off configuration pure and requires both reviewed revisions", () => {
    expect(inspectBridgeConfiguration({ type: "Disabled" })).toEqual({
      type: "Disabled",
    });
    expect(
      inspectBridgeConfiguration({
        type: "Configured",
        generation: "a",
        approvalReference: "fixture",
        bundles: [],
      }).type,
    ).toBe("Unavailable");
  });
});
