import { describe, expect, it, vi } from "vitest";

import {
  enterEvergreenPitch,
  type EvergreenPitchEntryEvidence,
  type EvergreenPitchEntryRepository,
} from "@/lib/subscriber-marketing/drovr-pitch-entry";
import { mapDrovrShadowFact } from "@/lib/subscriber-marketing/drovr-shadow-emitter";
import type { ContactEventRecord } from "@/lib/subscriber-marketing/types";

import {
  createBackfillFactDispatcher,
  DEFAULT_BACKFILL_FLOOR,
  EVERGREEN_PITCH_ENABLE_INSTANT,
  parseEvergreenPitchBackfillArgs,
  resolveBackfillApplyInngestEventKey,
  runEvergreenPitchBackfill,
  selectBackfillPopulation,
  type BackfillCandidate,
  type BackfillPopulationRow,
  type EvergreenPitchBackfillRepository,
} from "./evergreen-pitch-backfill";

const birthInstant = "2026-09-18T12:34:56.789Z";
const floor = DEFAULT_BACKFILL_FLOOR;
const enableInstant = EVERGREEN_PITCH_ENABLE_INSTANT;

function row(
  contactId: string,
  completedAt: string,
  overrides: Partial<BackfillPopulationRow> = {},
): BackfillPopulationRow {
  return {
    intentId: `intent-${contactId}-${completedAt}`,
    contactId,
    completedAt,
    emailResourceId: "ai-hero-skills-workflow.email-7",
    valuePathSlug: "ai-hero-skills-workflow",
    ...overrides,
  };
}

function candidate(
  contactId: string,
  completedAt = "2026-09-17T12:00:00.000Z",
): BackfillCandidate {
  return {
    contactId,
    completedAt,
    valuePathSlug: "ai-hero-skills-workflow",
  };
}

function fakeRepository(args: {
  population: BackfillCandidate[];
  purchaserContactIds?: string[];
  enter?: EvergreenPitchBackfillRepository["enterEvergreenPitch"];
  dispatch?: EvergreenPitchBackfillRepository["dispatchFact"];
}) {
  return {
    loadPopulation: vi.fn(async () => args.population),
    findCrashCoursePurchaserContactIds: vi.fn(
      async () => args.purchaserContactIds ?? [],
    ),
    enterEvergreenPitch: vi.fn(
      args.enter ??
        (async () => ({
          status: "entered" as const,
          journeyId: "crash-course-evergreen-offer" as const,
        })),
    ),
    dispatchFact: vi.fn(args.dispatch ?? (async () => "queued" as const)),
  };
}

function runArgs(
  repository: EvergreenPitchBackfillRepository,
  overrides: Partial<Parameters<typeof runEvergreenPitchBackfill>[0]> = {},
): Parameters<typeof runEvergreenPitchBackfill>[0] {
  return {
    repository,
    floor,
    enableInstant,
    limit: 25,
    apply: true,
    birthInstant,
    ...overrides,
  };
}

describe("evergreen pitch backfill population", () => {
  it("keeps bounded terminal finishers newest first and excludes owners and sized purchasers", () => {
    const rows = [
      row("before-floor", "2026-08-25T23:59:59.999Z"),
      row("at-floor", "2026-08-26T00:00:00.000Z"),
      row("individual-newest", "2026-09-17T23:00:00.000Z"),
      row("team", "2026-09-17T22:00:00.000Z", {
        emailResourceId: "ai-hero-skills-team-workflow.team-email-7",
        valuePathSlug: "ai-hero-skills-team-workflow",
      }),
      row("duplicate", "2026-09-17T20:00:00.000Z"),
      row("duplicate", "2026-09-16T20:00:00.000Z"),
      row("already-owned", "2026-09-17T19:00:00.000Z"),
      row("purchaser", "2026-09-17T18:00:00.000Z"),
      row("at-enable", enableInstant),
      row("not-terminal", "2026-09-17T17:00:00.000Z", {
        emailResourceId: "ai-hero-skills-workflow.email-6",
      }),
    ];

    expect(
      selectBackfillPopulation({
        rows,
        floor,
        enableInstant,
        limit: 10,
        alreadyEnteredContactIds: new Set(["already-owned"]),
        purchaserContactIds: new Set(["purchaser"]),
      }),
    ).toEqual([
      candidate("individual-newest", "2026-09-17T23:00:00.000Z"),
      {
        contactId: "team",
        completedAt: "2026-09-17T22:00:00.000Z",
        valuePathSlug: "ai-hero-skills-team-workflow",
      },
      candidate("duplicate", "2026-09-17T20:00:00.000Z"),
      candidate("at-floor", "2026-08-26T00:00:00.000Z"),
    ]);
  });
});

describe("evergreen pitch backfill run", () => {
  it("uses the run birth instant and backfill key while retaining historic completion in the payload", async () => {
    const completedAt = "2026-09-17T12:00:00.000Z";
    const repository = fakeRepository({
      population: [candidate("contact-1", completedAt)],
    });

    const summary = await runEvergreenPitchBackfill(runArgs(repository));

    expect(repository.enterEvergreenPitch).toHaveBeenCalledWith({
      contactId: "contact-1",
      completedAt: birthInstant,
    });
    expect(repository.dispatchFact).toHaveBeenCalledTimes(1);
    const fact = repository.dispatchFact.mock.calls[0]![0];
    expect(mapDrovrShadowFact(fact)).toEqual([
      expect.objectContaining({
        tenantId: "org-aihero",
        journeyId: "crash-course-evergreen-offer",
        type: "course.sequence-exhausted",
        occurredAt: birthInstant,
        idempotencyKey:
          "aihero:backfill:contact-1:ai-hero-skills-workflow:2026-09-18",
        payload: expect.objectContaining({ completedAt }),
      }),
    ]);
    expect(summary).toMatchObject({
      birthInstant,
      requested: 25,
      selected: 1,
      entered: 1,
      enteredContactIds: ["contact-1"],
      errors: [],
    });
  });

  it("aborts the whole population before entry or delivery when the second purchase check finds anyone", async () => {
    const repository = fakeRepository({
      population: [candidate("safe"), candidate("purchaser")],
      purchaserContactIds: ["purchaser"],
    });

    const summary = await runEvergreenPitchBackfill(runArgs(repository));

    expect(summary.refused["crash-course-purchaser"]).toBe(1);
    expect(summary.errors).toEqual([
      "population-abort: 1 live Crash Course purchaser in selected slice",
    ]);
    expect(repository.enterEvergreenPitch).not.toHaveBeenCalled();
    expect(repository.dispatchFact).not.toHaveBeenCalled();
  });

  it("still uses enterEvergreenPitch live evidence after the population check", async () => {
    const evidence: EvergreenPitchEntryEvidence = {
      contact: {
        id: "became-purchaser",
        userId: "user-1",
        email: "learner@example.com",
        name: "Learner",
        lifecycle: "nurture-ready",
        isProvisional: false,
        createdAt: floor,
        updatedAt: birthInstant,
      },
      providerIdentity: {
        id: "identity-1",
        contactId: "became-purchaser",
        provider: "kit",
        externalId: "kit-1",
        evidence: {
          source: "kit",
          strength: "strong",
          providerIdentity: { provider: "kit", externalId: "kit-1" },
        },
        createdAt: floor,
        updatedAt: birthInstant,
      },
      hasCrashCoursePurchase: true,
      unsubscribed: false,
    };
    const createContactEvent = vi.fn();
    const entryRepository: EvergreenPitchEntryRepository = {
      readEvergreenPitchEntryEvidence: vi.fn(async () => evidence),
      findContactEventsByType: vi.fn(async () => []),
      createContactEvent,
    };
    const repository = fakeRepository({
      population: [candidate("became-purchaser")],
      purchaserContactIds: [],
      enter: ({ contactId, completedAt }) =>
        enterEvergreenPitch({
          repository: entryRepository,
          contactId,
          completedAt,
        }),
    });

    const summary = await runEvergreenPitchBackfill(runArgs(repository));

    expect(summary.refused["crash-course-purchaser"]).toBe(1);
    expect(summary.entered).toBe(0);
    expect(createContactEvent).not.toHaveBeenCalled();
    expect(repository.dispatchFact).not.toHaveBeenCalled();
  });

  it("counts every specified refusal reason", async () => {
    const statuses = new Map([
      [
        "already",
        {
          status: "already-entered" as const,
          journeyId: "crash-course-evergreen-offer" as const,
        },
      ],
      [
        "unsubscribed",
        { status: "refused" as const, reason: "unsubscribed" as const },
      ],
      [
        "missing",
        {
          status: "refused" as const,
          reason: "contact-or-identity-missing" as const,
        },
      ],
      [
        "purchaser",
        {
          status: "refused" as const,
          reason: "crash-course-purchaser" as const,
        },
      ],
    ]);
    const repository = fakeRepository({
      population: [...statuses.keys()].map((contactId) => candidate(contactId)),
      enter: async ({ contactId }) => statuses.get(contactId)!,
    });

    const summary = await runEvergreenPitchBackfill(runArgs(repository));

    expect(summary.refused).toEqual({
      "crash-course-purchaser": 1,
      unsubscribed: 1,
      "contact-or-identity-missing": 1,
      "already-entered": 1,
    });
    expect(repository.dispatchFact).not.toHaveBeenCalled();
  });

  it("dry-run selects the slice but performs no entry or delivery writes", async () => {
    const repository = fakeRepository({
      population: [candidate("contact-1")],
    });

    const summary = await runEvergreenPitchBackfill(
      runArgs(repository, { apply: false }),
    );

    expect(summary.mode).toBe("dry-run");
    expect(summary.selected).toBe(1);
    expect(summary.entered).toBe(0);
    expect(repository.enterEvergreenPitch).not.toHaveBeenCalled();
    expect(repository.dispatchFact).not.toHaveBeenCalled();
  });

  it("stops after the first error", async () => {
    const repository = fakeRepository({
      population: [candidate("broken"), candidate("never-reached")],
      enter: async ({ contactId }) => {
        if (contactId === "broken") throw new Error("database unavailable");
        return {
          status: "entered" as const,
          journeyId: "crash-course-evergreen-offer" as const,
        };
      },
    });

    const summary = await runEvergreenPitchBackfill(runArgs(repository));

    expect(summary.errors).toEqual(["contact broken: database unavailable"]);
    expect(repository.enterEvergreenPitch).toHaveBeenCalledTimes(1);
    expect(repository.dispatchFact).not.toHaveBeenCalled();
  });

  it.each(["fallback", "nothing"] as const)(
    "counts a %s dispatch as an error, never as entered, and stops",
    async (delivery) => {
      const repository = fakeRepository({
        population: [
          candidate("ownership-recorded"),
          candidate("never-reached"),
        ],
        dispatch: async () => delivery,
      });

      const summary = await runEvergreenPitchBackfill(runArgs(repository));

      expect(summary.entered).toBe(0);
      expect(summary.enteredContactIds).toEqual(["ownership-recorded"]);
      expect(summary.errors).toEqual([
        `contact ownership-recorded: backfill dispatch returned ${delivery}`,
      ]);
      expect(repository.enterEvergreenPitch).toHaveBeenCalledTimes(1);
      expect(repository.dispatchFact).toHaveBeenCalledTimes(1);
    },
  );

  it("sends the mapped batch through Inngest HTTP without the Next.js client", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ids: ["inngest-event-1"], status: 200 }),
      );
    const dispatch = createBackfillFactDispatcher({
      eventKey: "test-event-key",
      fetchImpl,
    });
    const fact = {
      kind: "course-completed" as const,
      contactId: "contact-1",
      valuePathSlug: "ai-hero-skills-workflow",
      completedAt: "2026-09-17T12:00:00.000Z",
      backfill: {
        occurredAt: birthInstant,
        idempotencyKey:
          "aihero:backfill:contact-1:ai-hero-skills-workflow:2026-09-18",
      },
    };

    await expect(dispatch(fact)).resolves.toBe("queued");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://inn.gs/e/test-event-key");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "drovr/events.deliver",
      data: {
        events: mapDrovrShadowFact(fact),
        source: "course-completed",
      },
    });
  });
});

describe("evergreen pitch backfill CLI", () => {
  it("is dry-run by default and requires an output path", () => {
    expect(
      parseEvergreenPitchBackfillArgs([
        "--limit",
        "25",
        "--out",
        "/tmp/backfill.json",
      ]),
    ).toEqual({
      floor: DEFAULT_BACKFILL_FLOOR,
      enableInstant: EVERGREEN_PITCH_ENABLE_INSTANT,
      limit: 25,
      apply: false,
      out: "/tmp/backfill.json",
    });
  });

  it("refuses apply before startup when the Inngest event key is missing or placeholder", () => {
    expect(
      resolveBackfillApplyInngestEventKey({}, { apply: false }),
    ).toBeNull();
    expect(() =>
      resolveBackfillApplyInngestEventKey({}, { apply: true }),
    ).toThrow("Apply requires INNGEST_EVENT_KEY");
    expect(() =>
      resolveBackfillApplyInngestEventKey(
        { INNGEST_EVENT_KEY: "[SENSITIVE]" },
        { apply: true },
      ),
    ).toThrow('INNGEST_EVENT_KEY holds the Vercel "[SENSITIVE]" placeholder');
  });

  it("requires one explicit mode when apply is requested", () => {
    expect(
      parseEvergreenPitchBackfillArgs([
        "--floor=2026-09-01T00:00:00Z",
        "--limit=25",
        "--out=/tmp/backfill.json",
        "--apply",
      ]),
    ).toMatchObject({ apply: true, limit: 25 });
    expect(() =>
      parseEvergreenPitchBackfillArgs([
        "--limit=25",
        "--out=/tmp/backfill.json",
        "--apply",
        "--dry-run",
      ]),
    ).toThrow("--apply and --dry-run are mutually exclusive");
  });
});
