import type { IncidentSnapshot, PublicStatus } from "../contracts/index";

const copy = {
  degraded: {
    title: "AI Hero is degraded",
    summary: "Some AI Hero requests are failing. We are investigating.",
  },
  outage: {
    title: "AI Hero outage",
    summary: "A core AI Hero path is unavailable. We are investigating.",
  },
  resolved: {
    title: "AI Hero incident resolved",
    summary: "AI Hero has recovered and passed the required checks.",
  },
} as const;

export function unknownStatus(generatedAt: string): PublicStatus {
  return {
    schemaVersion: "aih.status.public.v1",
    overall: "unknown",
    components: [
      { key: "web", state: "unknown" },
      { key: "auth", state: "unknown" },
      { key: "checkout", state: "unknown" },
      { key: "content", state: "unknown" },
      { key: "learner_flow", state: "unknown" },
      { key: "database", state: "unknown" },
      { key: "email", state: "unknown" },
    ],
    incidents: [],
    generatedAt,
    sourceIncidentVersion: 0,
  };
}

export function buildPublicProjection(
  current: PublicStatus,
  incident: IncidentSnapshot,
  to: "operational" | "degraded" | "outage",
  generatedAt: string,
): PublicStatus {
  const publicState = to === "operational" ? "resolved" : to;
  const item = {
    id: incident.incidentId,
    state: publicState,
    title: copy[publicState].title,
    summary: copy[publicState].summary,
    startedAt: incident.openedAt,
    updatedAt: generatedAt,
    ...(publicState === "resolved" ? { resolvedAt: incident.resolvedAt ?? generatedAt } : {}),
  } as const;
  const incidents = [
    item,
    ...current.incidents.filter((value) => value.id !== incident.incidentId),
  ];
  const components = current.components.map((component) => ({
    key: component.key,
    state: component.key === incident.target ? to : component.state,
  }));

  const activeStates = [
    ...components.map((component) => component.state),
    ...incidents.filter((item) => item.state !== "resolved").map((item) => item.state),
  ];
  const overall = activeStates.includes("outage")
    ? "outage"
    : activeStates.includes("degraded")
      ? "degraded"
      : activeStates.includes("unknown")
        ? "unknown"
        : "operational";

  return {
    schemaVersion: "aih.status.public.v1",
    overall,
    components,
    incidents,
    generatedAt,
    sourceIncidentVersion: incident.version,
  };
}

export const PUBLIC_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300";
export const PRIVATE_CACHE_CONTROL = "private, no-store";
