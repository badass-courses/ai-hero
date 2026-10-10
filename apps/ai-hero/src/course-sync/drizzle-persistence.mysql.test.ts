import { preserveQueryResultShape } from "@/db/mysql-query-client";
import * as schema from "@/db/schema";
import { log } from "@/server/logger";
import { eq, is, SQL, sql } from "drizzle-orm";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { sha256, stableJson } from "./control-plane";
import * as invariants from "./persistence-invariants";
import {
  subtreeApplyFixture,
  subtreeBinding,
} from "./test-fixtures/subtree-apply-plan";

const state = vi.hoisted(() => ({ database: undefined as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return state.database;
  },
}));
vi.mock("@/server/logger", () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock("./types", async (original) => ({
  ...(await original<typeof import("./types")>()),
  getServerCourseSyncBinding: () => subtreeBinding,
}));
import { drizzleCourseSyncPersistence } from "./drizzle-persistence";

const realVerifyActivation = invariants.verifyCourseSyncActivation;
const uri = process.env.AIH_COURSE_SYNC_MYSQL_URL;
const suite = uri ? describe : describe.skip;
const tables = [
  schema.products,
  schema.contentResource,
  schema.contentResourceProduct,
  schema.contentResourceResource,
  schema.contentResourceVersion,
  schema.courseSyncBinding,
  schema.courseSyncSourceRevision,
  schema.courseSyncRun,
  schema.courseSyncRunResourceVersion,
  schema.courseSyncPollState,
];
const dialect = new MySqlDialect();

/** Derive disposable DDL from the installed production schema, including unique keys. */
async function createFixtureSchema(pool: Pool) {
  for (const table of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const fallback =
        column.default === undefined
          ? ""
          : column.default === null
            ? " DEFAULT NULL"
            : is(column.default, SQL)
              ? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`
              : column.getSQLType() === "json"
                ? ` DEFAULT ('${JSON.stringify(column.default)}')`
                : ` DEFAULT '${String(column.default)}'`;
      return `\`${column.name}\` ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${fallback}${column.primary ? " PRIMARY KEY" : ""}${column.isUnique ? " UNIQUE" : ""}`;
    });
    for (const key of config.primaryKeys)
      columns.push(
        `PRIMARY KEY (${key.columns.map((c) => `\`${c.name}\``).join(",")})`,
      );
    for (const key of config.uniqueConstraints) {
      columns.push(
        `UNIQUE KEY \`${key.getName()}\` (${key.columns.map((c) => `\`${c.name}\``).join(",")})`,
      );
    }
    for (const index of config.indexes.filter((i) => i.config.unique)) {
      const names = index.config.columns.map((c) => {
        if (!("name" in c))
          throw new Error("Expression indexes require explicit fixture DDL");
        return `\`${c.name}\``;
      });
      columns.push(`UNIQUE KEY \`${index.config.name}\` (${names.join(",")})`);
    }
    await pool.query(
      `CREATE TABLE IF NOT EXISTS \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`,
    );
  }
}

suite("course-sync activation: real MySQL 8", () => {
  let pool: Pool;
  let database: MySql2Database<typeof schema>;
  let fixture: ReturnType<typeof subtreeApplyFixture>;

  beforeAll(async () => {
    const parsed = new URL(uri!);
    if (
      !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
      parsed.pathname !== "/course_sync_verifier_test"
    ) {
      throw new Error(
        "Only the disposable loopback course_sync_verifier_test database is allowed",
      );
    }
    const server = new URL(uri!);
    server.pathname = "/";
    const connection = await mysql.createConnection({
      uri: server.toString(),
      timezone: "Z",
    });
    await connection.query(
      "CREATE DATABASE IF NOT EXISTS course_sync_verifier_test",
    );
    await connection.end();
    pool = preserveQueryResultShape(
      mysql.createPool({ uri: uri!, connectionLimit: 2, timezone: "Z" }),
    );
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = (async () =>
      preserveQueryResultShape(
        await getConnection(),
      )) as typeof pool.getConnection;
    await createFixtureSchema(pool);
    database = drizzle(pool, { schema, mode: "planetscale" });
    state.database = database;
  }, 30000);
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(log.error).mockClear();
    vi.spyOn(invariants, "verifyCourseSyncActivation");
    for (const table of [...tables].reverse())
      await pool.query(`DELETE FROM \`${getTableConfig(table).name}\``);
    fixture = subtreeApplyFixture();
    const { plan, previousFields } = fixture;
    await database.insert(schema.products).values({
      id: subtreeBinding.productId,
      name: "Synthetic cohort",
      key: "synthetic-cohort",
      type: "cohort",
      fields: { state: "draft", visibility: "unlisted" },
    });
    await database.insert(schema.contentResource).values({
      id: subtreeBinding.anchorCohortId,
      type: "cohort",
      createdById: "test-operator",
      fields: { state: "published", visibility: "public" },
    });
    await database.insert(schema.contentResourceProduct).values({
      productId: subtreeBinding.productId,
      resourceId: subtreeBinding.anchorCohortId,
      position: 0,
    });
    await database.insert(schema.courseSyncBinding).values({
      bindingId: subtreeBinding.bindingId,
      sourceCourseId: subtreeBinding.sourceCourseId,
      productId: subtreeBinding.productId,
      anchorWorkshopId: subtreeBinding.anchorCohortId,
      status: "active",
      binding: subtreeBinding,
    });
    await database.insert(schema.courseSyncSourceRevision).values({
      sourceRevisionId: plan.sourceRevisionId,
      bindingId: plan.bindingId,
      courseVersionId: plan.courseVersionId,
      providerRevision: "test-provider",
      manifestSha256: "a".repeat(64),
      stagedAt: new Date(),
      manifest: { schemaVersion: 4 },
    });
    await database.insert(schema.courseSyncRun).values({
      runId: "test-run",
      bindingId: plan.bindingId,
      sourceRevisionId: plan.sourceRevisionId,
      courseVersionId: plan.courseVersionId,
      state: "previewed",
      stageIdempotencyKey: "test-stage",
      stageFingerprint: "b".repeat(64),
      planSha256: plan.planSha256,
      plan,
    });
    await database.insert(schema.courseSyncPollState).values({
      bindingId: plan.bindingId,
      courseVersionId: plan.courseVersionId,
      providerRevision: "test-provider",
      status: "awaiting-apply",
      controlPlaneRunId: "test-run",
      applyPolicyOverride: "operator",
      consecutiveFailures: 0,
    });
    const existing = plan.resources.filter((r) => r.action !== "create");
    await database.insert(schema.contentResource).values(
      existing.map((r) => ({
        id: r.targetResourceId,
        type: r.sourceKind,
        createdById: "test-operator",
        currentVersionId: r.previousVersionId,
        fields: previousFields.get(r.targetResourceId),
      })),
    );
    await database.insert(schema.contentResourceVersion).values(
      existing.map((r) => ({
        id: r.previousVersionId!,
        resourceId: r.targetResourceId,
        versionNumber: 1,
        createdById: "test-operator",
        fields: previousFields.get(r.targetResourceId),
      })),
    );
    await database.insert(schema.contentResourceResource).values(
      existing.map((r) => ({
        resourceId: r.targetResourceId,
        resourceOfId: r.previousParentResourceId!,
        position: r.previousPosition!,
        metadata: { bindingId: plan.bindingId, sourceId: r.sourceId },
        deletedAt: null,
      })),
    );
  });

  it("applies 8 workshop/59 lesson detaches, nested subtrees, survivor moves, 6 lesson creates and 104 updates", async () => {
    const { plan } = fixture;
    expect(
      plan.resources.reduce(
        (counts, r) => ({ ...counts, [r.action]: (counts[r.action] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    ).toEqual({ update: 104, retain: 23, create: 77 });
    expect(
      plan.resources.filter(
        (r) => r.sourceKind === "lesson" && r.action === "create",
      ),
    ).toHaveLength(6);
    expect(plan.media).toHaveLength(38);
    const error = await drizzleCourseSyncPersistence
      .applyAtomically({
        runId: "test-run",
        plan,
        idempotencyKey: "test-apply",
        createdById: "test-operator",
      })
      .then(
        () => null,
        (error) => error,
      );
    expect(
      vi.mocked(invariants.verifyCourseSyncActivation).mock.results.at(-1)
        ?.value,
    ).toEqual({ ok: true });
    expect(error).toBeNull();
    const [run] = await database
      .select()
      .from(schema.courseSyncRun)
      .where(eq(schema.courseSyncRun.runId, "test-run"));
    expect(run?.state).toBe("applied");
    const relations = await database
      .select()
      .from(schema.contentResourceResource);
    // 67 explicit detaches plus the former parent edge of one surviving lesson.
    expect(relations.filter((r) => r.deletedAt !== null)).toHaveLength(68);
    for (const item of plan.resources)
      expect(
        relations.find(
          (r) =>
            r.resourceId === item.targetResourceId &&
            r.resourceOfId === item.parentResourceId,
        ),
      ).toMatchObject({
        resourceOfId: item.parentResourceId,
        position: item.position,
        deletedAt: item.detached ? expect.any(Date) : null,
      });
    const liveWorkshops = relations.filter(
      (r) =>
        r.resourceOfId === subtreeBinding.anchorCohortId &&
        r.deletedAt === null,
    );
    expect(liveWorkshops.map((r) => r.position).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    for (const parent of liveWorkshops) {
      const positions = relations
        .filter(
          (r) => r.resourceOfId === parent.resourceId && r.deletedAt === null,
        )
        .map((r) => r.position)
        .sort((a, b) => a - b);
      expect(positions).toEqual(positions.map((_, index) => index));
    }
    const receipts = await database
      .select()
      .from(schema.courseSyncRunResourceVersion);
    expect(receipts).toHaveLength(204);
    const pointers = new Map(
      (await database.select().from(schema.contentResource)).map((r) => [
        r.id,
        r.currentVersionId,
      ]),
    );
    expect(
      receipts.every(
        (r) => pointers.get(r.resourceId) === r.contentResourceVersionId,
      ),
    ).toBe(true);
    const [poll] = await database.select().from(schema.courseSyncPollState);
    expect(poll).toMatchObject({
      status: "succeeded",
      consecutiveFailures: 0,
      applyPolicyOverride: null,
    });
    const moved = plan.resources.find(
      (r) =>
        r.previousParentResourceId &&
        r.previousParentResourceId !== r.parentResourceId,
    )!;
    expect(
      relations.filter(
        (r) => r.resourceId === moved.targetResourceId && r.deletedAt === null,
      ),
    ).toHaveLength(1);
    expect(
      relations.find(
        (r) =>
          r.resourceId === moved.targetResourceId &&
          r.resourceOfId === moved.previousParentResourceId,
      ),
    ).toMatchObject({
      position: moved.previousPosition,
      deletedAt: expect.any(Date),
    });

    await drizzleCourseSyncPersistence.rollbackAtomically({
      runId: "test-run",
      bindingId: plan.bindingId,
      idempotencyKey: "test-rollback",
      compensatingRunId: "test-compensating",
      createdById: "test-operator",
    });
    const restored = await database
      .select()
      .from(schema.contentResourceResource);
    for (const item of plan.resources.filter((r) => r.action !== "create")) {
      expect(
        restored.find(
          (r) =>
            r.resourceId === item.targetResourceId &&
            r.resourceOfId === item.previousParentResourceId,
        ),
      ).toMatchObject({ position: item.previousPosition, deletedAt: null });
    }
    expect(
      restored.find(
        (r) =>
          r.resourceId === moved.targetResourceId &&
          r.resourceOfId === moved.parentResourceId,
      )?.deletedAt,
    ).toBeInstanceOf(Date);
  });

  it("recovers a rolled-back failed head only with its original idempotency key", async () => {
    await database
      .update(schema.courseSyncRun)
      .set({
        state: "failed",
        applyIdempotencyKey: "original-key",
        failureCode: "APPLY_WRITE_VERIFICATION_FAILED",
      })
      .where(eq(schema.courseSyncRun.runId, "test-run"));
    await expect(
      drizzleCourseSyncPersistence.applyAtomically({
        runId: "test-run",
        plan: fixture.plan,
        idempotencyKey: "different-key",
        createdById: "test-operator",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      drizzleCourseSyncPersistence.applyAtomically({
        runId: "test-run",
        plan: fixture.plan,
        idempotencyKey: "original-key",
        createdById: "test-operator",
      }),
    ).resolves.toMatchObject({ state: "applied" });
  });

  it("does not restamp a historical tombstone when reattaching at a new parent", async () => {
    const moved = fixture.plan.resources.find(
      (r) => r.targetResourceId === "lesson-0-0",
    )!;
    moved.previousDetached = true;
    const { planSha256: _oldHash, ...input } = fixture.plan;
    fixture.plan.planSha256 = sha256(stableJson(input));
    await database
      .update(schema.courseSyncRun)
      .set({ plan: fixture.plan, planSha256: fixture.plan.planSha256 })
      .where(eq(schema.courseSyncRun.runId, "test-run"));
    const previousDeletedAt = new Date("2020-01-01T00:00:00.123Z");
    await database
      .update(schema.contentResourceResource)
      .set({ deletedAt: previousDeletedAt })
      .where(
        eq(schema.contentResourceResource.resourceId, moved.targetResourceId),
      );
    await drizzleCourseSyncPersistence.applyAtomically({
      runId: "test-run",
      plan: fixture.plan,
      idempotencyKey: "test-apply",
      createdById: "test-operator",
    });
    const rows = await database
      .select()
      .from(schema.contentResourceResource)
      .where(
        eq(schema.contentResourceResource.resourceId, moved.targetResourceId),
      );
    expect(
      rows.find((r) => r.resourceOfId === moved.previousParentResourceId)
        ?.deletedAt,
    ).toEqual(previousDeletedAt);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1);
  });

  it("preserves an untagged relation outside the binding tree during a move", async () => {
    await database.insert(schema.contentResource).values({
      id: "hand-curated",
      type: "workshop",
      createdById: "test-operator",
      fields: {},
    });
    await database.insert(schema.contentResourceResource).values({
      resourceId: "lesson-0-0",
      resourceOfId: "hand-curated",
      position: 8,
      metadata: null,
    });
    await drizzleCourseSyncPersistence.applyAtomically({
      runId: "test-run",
      plan: fixture.plan,
      idempotencyKey: "test-apply",
      createdById: "test-operator",
    });
    const rows = await database
      .select()
      .from(schema.contentResourceResource)
      .where(eq(schema.contentResourceResource.resourceOfId, "hand-curated"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resourceId: "lesson-0-0",
      position: 8,
      deletedAt: null,
      metadata: null,
    });
  });

  it.each([false, true])(
    "logs the failing check/counts and rolls back even when loggerFails=%s",
    async (loggerFails) => {
      vi.mocked(invariants.verifyCourseSyncActivation).mockImplementationOnce(
        (...args) => {
          const old = args[3].find(
            (r) =>
              r.resourceId === "lesson-0-0" && r.resourceOfId === "workshop-3",
          )!;
          old.deletedAt = null; // Fault injection: the old tombstone is read as live.
          return realVerifyActivation(...args);
        },
      );
      const fallback = vi.spyOn(console, "error").mockImplementation(() => {});
      if (loggerFails)
        vi.mocked(log.error).mockRejectedValueOnce(
          new Error("Synthetic logging outage"),
        );
      await expect(
        drizzleCourseSyncPersistence.applyAtomically({
          runId: "test-run",
          plan: fixture.plan,
          idempotencyKey: "test-apply",
          createdById: "test-operator",
        }),
      ).rejects.toMatchObject({
        code: "APPLY_WRITE_VERIFICATION_FAILED",
        details: {
          check: "relation_count_mismatch",
          counts: {
            failedExpectedLiveRelations: 1,
            failedReadbackLiveRelations: 2,
          },
        },
      });
      expect(log.error).toHaveBeenCalledWith(
        "course_sync.apply_verification_failed",
        {
          runId: "test-run",
          bindingId: fixture.plan.bindingId,
          planSha256: fixture.plan.planSha256,
          check: "relation_count_mismatch",
          counts: expect.objectContaining({
            plannedResources: 204,
            readbackResources: 204,
            receipts: 204,
            plannedDetaches: 67,
            plannedMoves: 1,
            failedExpectedLiveRelations: 1,
            failedReadbackLiveRelations: 2,
          }),
        },
      );
      const data = vi.mocked(log.error).mock.calls[0]![1]!;
      expect(Object.keys(data).sort()).toEqual([
        "bindingId",
        "check",
        "counts",
        "planSha256",
        "runId",
      ]);
      if (loggerFails)
        expect(fallback).toHaveBeenCalledWith(
          "course_sync.apply_verification_failed",
          data,
        );
      const resources = await database.select().from(schema.contentResource);
      expect(resources).toHaveLength(128); // Anchor + all 127 original resources, no creates committed.
      const receipts = await database
        .select()
        .from(schema.courseSyncRunResourceVersion);
      expect(receipts).toHaveLength(0);
      const relations = await database
        .select()
        .from(schema.contentResourceResource);
      expect(relations).toHaveLength(127);
      expect(relations.every((r) => r.deletedAt === null)).toBe(true);
    },
  );
});
