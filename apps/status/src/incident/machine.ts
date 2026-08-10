import { createActor, createMachine } from "xstate";
import type { IncidentState } from "../contracts/index";

export type IncidentMachineEvent =
  | { type: "FAILURE" }
  | { type: "EVALUATE"; classification: "none" | "degraded" | "outage" }
  | { type: "WINDOW_CLOSED" }
  | { type: "RECOVERY_READY" }
  | { type: "RESOLUTION_READY" };

export const incidentMachine = createMachine(
  {
    types: {} as { events: IncidentMachineEvent },
    id: "aiHeroIncident",
    initial: "healthy",
    states: {
      healthy: {
        on: { FAILURE: "investigating" },
      },
      investigating: {
        on: {
          EVALUATE: [
            { guard: "isOutage", target: "outage" },
            { guard: "isDegraded", target: "degraded" },
          ],
          WINDOW_CLOSED: "healthy",
        },
      },
      degraded: {
        on: {
          EVALUATE: { guard: "isOutage", target: "outage" },
          RECOVERY_READY: "recovering",
        },
      },
      outage: {
        on: { RECOVERY_READY: "recovering" },
      },
      recovering: {
        on: {
          EVALUATE: [
            { guard: "isOutage", target: "outage" },
            { guard: "isDegraded", target: "degraded" },
          ],
          RESOLUTION_READY: "resolved",
        },
      },
      resolved: { type: "final" },
    },
  },
  {
    guards: {
      isOutage: ({ event }) => event.type === "EVALUATE" && event.classification === "outage",
      isDegraded: ({ event }) => event.type === "EVALUATE" && event.classification === "degraded",
    },
  },
);

export function transitionIncident(
  from: IncidentState,
  event: IncidentMachineEvent,
): { state: IncidentState; changed: boolean } {
  const snapshot = incidentMachine.resolveState({ value: from, context: {} });
  const actor = createActor(incidentMachine, { snapshot }).start();
  actor.send(event);
  const state = actor.getSnapshot().value as IncidentState;
  actor.stop();
  return { state, changed: state !== from };
}
