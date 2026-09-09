import { Effect } from "effect";
import { z } from "zod";
import {
  supportsPinnedPlanetScaleSnapshot,
  type VerifiedProviderReceipt,
} from "../../scripts/contact-maintenance-provider-receipt";
import {
  assertEmailKeyRuntime,
  contactEmailWriteValues,
  normalizeEmail,
} from "./contact-email-equivalence";
import { schemaReady, type MetadataRow } from "./contact-maintenance-schema";

export type MaintenanceConnection = {
  query(sql: string, values: unknown[], timeoutMs: number): Promise<unknown>;
  destroy(): void;
};
export const maintenanceOptionsSchema = z
  .object({
    mode: z.enum(["inspect", "dry-run", "apply", "verify"]),
    pageSize: z.number().int().min(1).max(500),
    maxRows: z.number().int().min(1).max(100000),
    maxWrites: z.number().int().min(0).max(10000),
    maxMs: z.number().int().min(100).max(60000),
    after: z.string().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "verify" && v.after)
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A verification snapshot cannot resume",
      });
  });
export type MaintenanceOptions = z.infer<typeof maintenanceOptionsSchema>;
const rowSchema = z
  .object({
    id: z.string().min(1).max(255),
    email: z.string().nullable(),
    emailKey: z.string().nullable(),
    emailKeySource: z.string().nullable(),
    emailKeyStale: z.number().int(),
    rawHex: z.string().nullable(),
  })
  .strict();
type ContactRow = z.infer<typeof rowSchema>;
type OutcomeCode =
  | "complete"
  | "partial"
  | "held"
  | "runtime-mismatch"
  | "schema-mismatch"
  | "unsupported-snapshot"
  | "database-uncertain"
  | "write-uncertain"
  | "budget-exhausted"
  | "invalid-options";
export type MaintenanceResult = {
  code: OutcomeCode;
  mode: string;
  schemaReady: boolean;
  coverage:
    | "none"
    | "schema-only"
    | "page-only"
    | "partial-snapshot"
    | "consistent-snapshot";
  snapshotStartedAt: string | null;
  snapshotEstablishedBy: string | null;
  snapshotEndedAt: string | null;
  snapshotProjectionValid: boolean;
  unqualifiedReady: false;
  counts: {
    scanned: number;
    matching: number;
    mismatching: number;
    malformed: number;
    stale: number;
    nullEmails: number;
    emptyNormalized: number;
    invalidRaw: number;
    ambiguousGroups: number;
    ambiguousRows: number;
    attemptedWrites: number;
    acknowledgedWrites: number;
    verifiedAfterWrite: number;
    conflicts: number;
    deleted: number;
    unknownWrites: number;
  };
  freshGlobalGuard: {
    observedAt: string;
    stalePresent: boolean;
    locking: false;
  } | null;
  /** Private machine state. MUST be separated from normal stdout/logging. */
  privateState: {
    after: string | undefined;
    unresolved: {
      id: string;
      reason: "conflict" | "deleted" | "invalid-raw";
    }[];
  };
};
class Stop extends Error {
  constructor(readonly code: OutcomeCode) {
    super(code);
  }
}
export const CONTACT_PROJECTION_CAS =
  "UPDATE AI_Contact SET emailKey = ?, emailKeySource = ? WHERE id = ? AND CAST(email AS BINARY) <=> CAST(? AS BINARY)";

/** The caller supplies one exclusive dedicated connection. This function owns
 * its lifecycle and destroys it on every exit; never use a shared pool handle.
 * preparing → schema-checked → scanning/applying/snapshot → complete/held/partial.
 * Query timeout or uncertain acknowledgement is terminal, never a write retry. */
export function maintainContactIntegrity(
  connection: MaintenanceConnection,
  rawOptions: MaintenanceOptions,
  dependencies: {
    runtime?: { node: string; unicode: string | undefined };
    monotonic?: () => number;
    providerEvidence?: VerifiedProviderReceipt;
  } = {},
) {
  return Effect.tryPromise({
    try: async () => {
      const result: MaintenanceResult = {
        code: "partial",
        mode: rawOptions.mode,
        schemaReady: false,
        coverage: "none",
        snapshotStartedAt: null,
        snapshotEstablishedBy: null,
        snapshotEndedAt: null,
        snapshotProjectionValid: false,
        unqualifiedReady: false,
        counts: {
          scanned: 0,
          matching: 0,
          mismatching: 0,
          malformed: 0,
          stale: 0,
          nullEmails: 0,
          emptyNormalized: 0,
          invalidRaw: 0,
          ambiguousGroups: 0,
          ambiguousRows: 0,
          attemptedWrites: 0,
          acknowledgedWrites: 0,
          verifiedAfterWrite: 0,
          conflicts: 0,
          deleted: 0,
          unknownWrites: 0,
        },
        freshGlobalGuard: null,
        privateState: { after: rawOptions.after, unresolved: [] },
      };
      const monotonic = dependencies.monotonic ?? (() => performance.now()),
        started = monotonic();
      let writeInFlight = false;
      try {
        const parsed = maintenanceOptionsSchema.safeParse(rawOptions);
        if (!parsed.success) throw new Stop("invalid-options");
        const o = parsed.data;
        try {
          assertEmailKeyRuntime(dependencies.runtime);
        } catch {
          throw new Stop("runtime-mismatch");
        }
        const remaining = () => {
          const left = o.maxMs - (monotonic() - started);
          if (left <= 0) throw new Stop("budget-exhausted");
          return Math.max(1, Math.floor(left));
        };
        const query = (sql: string, values: unknown[] = []): Promise<unknown> =>
          connection.query(sql, values, remaining());
        const rows = async (
          sql: string,
          values: unknown[] = [],
        ): Promise<MetadataRow[]> =>
          z.array(z.record(z.unknown())).parse(await query(sql, values));
        const inspectSchema = async () => {
          const columns = await rows(
            "SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='AI_Contact'",
          );
          const indexes = await rows(
            "SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE,SUB_PART,IS_VISIBLE,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='AI_Contact'",
          );
          const tables = await rows(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='AI_Contact'",
          );
          if (!schemaReady(columns, indexes, tables))
            throw new Stop("schema-mismatch");
        };
        await inspectSchema();
        const server = (
          await rows(
            "SELECT VERSION() version, @@version_comment comment, DATABASE() databaseName, @@character_set_client clientCharset, @@character_set_connection connectionCharset, @@character_set_results resultsCharset",
          )
        )[0];
        if (
          !server ||
          ["clientCharset", "connectionCharset", "resultsCharset"].some(
            (k) => server[k] !== "utf8mb4",
          )
        )
          throw new Stop("schema-mismatch");
        result.schemaReady = true;
        if (o.mode === "inspect") {
          result.code = "complete";
          result.coverage = "schema-only";
          return result;
        }
        const timestamp = async () => {
          const t = (
            await rows(
              "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') at",
            )
          )[0]?.at;
          if (typeof t !== "string") throw new Stop("database-uncertain");
          return t;
        };
        if (o.mode === "verify") {
          const native =
            !dependencies.providerEvidence &&
            /^8\.4\./.test(String(server.version)) &&
            server.comment === "MySQL Community Server - GPL";
          if (
            !native &&
            !supportsPinnedPlanetScaleSnapshot(
              dependencies.providerEvidence,
              server,
              remaining(),
            )
          )
            throw new Stop("unsupported-snapshot");
          await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          result.snapshotStartedAt = await timestamp();
          await query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
          await query("SELECT id FROM AI_Contact LIMIT 0");
          // Hold the table metadata lock before rechecking the generated expression.
          await inspectSchema();
          result.snapshotEstablishedBy = await timestamp();
          result.coverage = "partial-snapshot";
        } else result.coverage = "page-only";
        const groups = new Map<string, number>();
        let exhausted = false,
          stop = false;
        function expected(row: ContactRow) {
          if (
            row.email === null
              ? row.rawHex !== null
              : Buffer.from(row.email, "utf8").toString("hex").toUpperCase() !==
                row.rawHex
          )
            throw new Error("Raw encoding mismatch");
          return contactEmailWriteValues(row.email);
        }
        const matches = (
          row: ContactRow,
          p: ReturnType<typeof contactEmailWriteValues>,
        ) =>
          row.emailKey === p.emailKey &&
          row.emailKeySource === p.emailKeySource &&
          row.emailKeyStale === 0;
        const select =
          "SELECT id,email,emailKey,emailKeySource,emailKeyStale,HEX(CAST(email AS BINARY)) rawHex FROM AI_Contact";
        while (!stop) {
          // One sentinel can prove exhaustion; inspected rows never exceed maxRows.
          const size = Math.min(
            o.pageSize,
            o.maxRows - result.counts.scanned + 1,
          );
          const page = z
            .array(rowSchema)
            .parse(
              await query(
                `${select}${result.privateState.after ? " WHERE id > ?" : ""} ORDER BY id LIMIT ${size}`,
                result.privateState.after ? [result.privateState.after] : [],
              ),
            );
          if (page.length === 0) {
            exhausted = true;
            break;
          }
          for (const row of page) {
            remaining();
            if (result.counts.scanned >= o.maxRows) {
              stop = true;
              break;
            }
            if (
              o.mode === "apply" &&
              result.counts.attemptedWrites >= o.maxWrites
            ) {
              stop = true;
              break;
            }
            result.counts.scanned++;
            if (row.email === null) result.counts.nullEmails++;
            else {
              const normalized = normalizeEmail(row.email);
              if (normalized === "") result.counts.emptyNormalized++;
              const n = (groups.get(normalized) ?? 0) + 1;
              groups.set(normalized, n);
              if (n === 2) {
                result.counts.ambiguousGroups++;
                result.counts.ambiguousRows += 2;
              } else if (n > 2) result.counts.ambiguousRows++;
            }
            if (row.emailKeyStale !== 0) result.counts.stale++;
            if (
              (row.emailKey !== null &&
                !/^v1:[a-f0-9]{64}$/.test(row.emailKey)) ||
              (row.emailKeySource !== null &&
                !/^[a-f0-9]{64}$/.test(row.emailKeySource))
            )
              result.counts.malformed++;
            let projection: ReturnType<typeof contactEmailWriteValues>;
            try {
              projection = expected(row);
            } catch {
              result.counts.invalidRaw++;
              result.privateState.unresolved.push({
                id: row.id,
                reason: "invalid-raw",
              });
              result.privateState.after = row.id;
              continue;
            }
            if (matches(row, projection)) result.counts.matching++;
            else {
              result.counts.mismatching++;
              if (o.mode === "apply") {
                result.counts.attemptedWrites++;
                writeInFlight = true;
                const acknowledgement = z
                  .object({
                    affectedRows: z.number().int().min(0).max(1),
                    warningStatus: z.literal(0),
                  })
                  .passthrough()
                  .safeParse(
                    await query(CONTACT_PROJECTION_CAS, [
                      projection.emailKey,
                      projection.emailKeySource,
                      row.id,
                      row.email,
                    ]),
                  );
                if (!acknowledgement.success) throw new Stop("write-uncertain");
                writeInFlight = false;
                result.counts.acknowledgedWrites +=
                  acknowledgement.data.affectedRows;
                const readback = z
                  .array(rowSchema)
                  .max(1)
                  .parse(
                    await query(`${select} WHERE id = ? LIMIT 1`, [row.id]),
                  );
                const fresh = readback[0];
                if (!fresh) {
                  result.counts.deleted++;
                  result.privateState.unresolved.push({
                    id: row.id,
                    reason: "deleted",
                  });
                } else if (
                  fresh.email !== row.email ||
                  !matches(fresh, expected(fresh))
                ) {
                  result.counts.conflicts++;
                  result.privateState.unresolved.push({
                    id: row.id,
                    reason: "conflict",
                  });
                } else result.counts.verifiedAfterWrite++;
              }
            }
            result.privateState.after = row.id;
          }
          if (!stop && page.length < size) {
            exhausted = true;
            break;
          }
        }
        result.code = exhausted ? "complete" : "partial";
        if (o.mode === "verify") {
          result.snapshotEndedAt = await timestamp();
          await query("COMMIT");
          if (exhausted) {
            result.coverage = "consistent-snapshot";
            result.snapshotProjectionValid =
              result.counts.mismatching === 0 && result.counts.invalidRaw === 0;
          }
          const fresh = (
            await rows(
              "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') at, EXISTS(SELECT 1 FROM AI_Contact WHERE emailKeyStale=1 LIMIT 1) stale",
            )
          )[0];
          if (
            !fresh ||
            typeof fresh.at !== "string" ||
            ![0, 1].includes(Number(fresh.stale))
          )
            throw new Stop("database-uncertain");
          result.freshGlobalGuard = {
            observedAt: fresh.at,
            stalePresent: Number(fresh.stale) === 1,
            locking: false,
          };
          if (
            exhausted &&
            (!result.snapshotProjectionValid ||
              result.counts.ambiguousGroups > 0 ||
              result.freshGlobalGuard.stalePresent)
          )
            result.code = "held";
        }
        if (result.privateState.unresolved.length && result.code === "complete")
          result.code = "held";
        return result;
      } catch (error) {
        if (writeInFlight) {
          result.counts.unknownWrites++;
          result.code = "write-uncertain";
        } else
          result.code =
            error instanceof Stop ? error.code : "database-uncertain";
        result.snapshotProjectionValid = false;
        return result;
      } finally {
        connection.destroy();
      }
    },
    catch: () => ({ type: "MaintenanceUnavailable" as const }),
  });
}
export function publicMaintenanceResult(result: MaintenanceResult) {
  const { privateState: _, ...safe } = result;
  return safe;
}
