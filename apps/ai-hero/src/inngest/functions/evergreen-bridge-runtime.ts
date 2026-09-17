import type { Inngest } from "inngest";
import { Effect } from "effect";
import { z } from "zod";
import { bridgeTickRequestSchema } from "@/lib/subscriber-marketing/evergreen-offer-journey/bridge-runtime";

const generation = z.string().min(1).max(100);
const recoveryCursor = z
  .object({
    leaseExpiresAt: z.string().datetime({ precision: 3 }),
    idempotencyKey: z.string().min(1).max(500),
  })
  .strict();
const recordedCursor = recoveryCursor
  .extend({ status: z.enum(["Accepted", "KnownNotApplied"]) })
  .strict();
const claimCursor = z
  .object({ after: z.string().min(1).max(500).optional() })
  .strict();
export const bridgeRuntimeCommandSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("scan"), request: bridgeTickRequestSchema })
    .strict(),
  z
    .object({ type: z.literal("claimSource"), generation, input: claimCursor })
    .strict(),
  z
    .object({
      type: z.literal("messageRecorded"),
      generation,
      input: z
        .object({ afterByScope: z.record(recordedCursor).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("messageUncertain"),
      generation,
      input: z
        .object({ afterByScope: z.record(recoveryCursor).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("couponRecorded"),
      generation,
      input: z.object({ after: recordedCursor.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("couponUncertain"),
      generation,
      input: z.object({ after: recoveryCursor.optional() }).strict(),
    })
    .strict(),
]);
import type {
  createBridgeRuntime,
  BridgeTickRequest,
} from "@/lib/subscriber-marketing/evergreen-offer-journey/bridge-runtime";

type Runtime = ReturnType<typeof createBridgeRuntime>;
export type BridgeRuntimeCommand =
  | { type: "scan"; request: BridgeTickRequest }
  | {
      type: "claimSource";
      generation: string;
      input: Parameters<Runtime["claimSource"]>[1];
    }
  | {
      type: "messageRecorded";
      generation: string;
      input: Parameters<Runtime["messageRecorded"]>[1];
    }
  | {
      type: "messageUncertain";
      generation: string;
      input: Parameters<Runtime["messageUncertain"]>[1];
    }
  | {
      type: "couponRecorded";
      generation: string;
      input: Parameters<Runtime["couponRecorded"]>[1];
    }
  | {
      type: "couponUncertain";
      generation: string;
      input: Parameters<Runtime["couponUncertain"]>[1];
    };

export function runBridgeRuntimeCommand(
  runtime: Runtime,
  command: BridgeRuntimeCommand,
) {
  switch (command.type) {
    case "scan":
      return Effect.runPromise(runtime.tick(command.request));
    case "claimSource":
      return Effect.runPromise(
        runtime.claimSource(command.generation, command.input),
      );
    case "messageRecorded":
      return Effect.runPromise(
        runtime.messageRecorded(command.generation, command.input),
      );
    case "messageUncertain":
      return Effect.runPromise(
        runtime.messageUncertain(command.generation, command.input),
      );
    case "couponRecorded":
      return Effect.runPromise(
        runtime.couponRecorded(command.generation, command.input),
      );
    case "couponUncertain":
      return Effect.runPromise(
        runtime.couponUncertain(command.generation, command.input),
      );
  }
}

export async function runBoundedBridgeEvent(
  resolve: () => Promise<Runtime | null>,
  input: unknown,
) {
  const decoded = bridgeRuntimeCommandSchema.safeParse(input);
  if (!decoded.success)
    return { type: "Unavailable" as const, reason: "InvalidCommand" };
  const runtime = await resolve();
  if (!runtime) return { type: "Disabled" as const };
  return runBridgeRuntimeCommand(runtime, decoded.data);
}

/** Opt-in factory, NOT exported by the production function registration list.
 * One independently durable page. No automatic retry/resend or continuation loop:
 * operator reads the receipt and explicitly schedules the returned cursor.
 */
export function createEvergreenBridgeRuntimeFunction(
  client: Inngest,
  resolve: () => Promise<Runtime | null>,
) {
  return client.createFunction(
    {
      id: "evergreen-bridge-runtime-v1",
      retries: 0,
      concurrency: 1,
      throttle: { limit: 1, period: "1s" },
    },
    { event: "aihero/evergreen-bridge.tick.requested" },
    async ({ event, step }) =>
      step.run("bounded-bridge-command", () =>
        runBoundedBridgeEvent(resolve, event.data),
      ),
  );
}
