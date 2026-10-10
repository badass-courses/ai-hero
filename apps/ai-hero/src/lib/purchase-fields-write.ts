import { db, type DbExecutor } from "@/db";
import { purchases } from "@/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";

/**
 * The one way app code writes `Purchase.fields`.
 *
 * Each top-level key is written with its own `JSON_SET` inside one UPDATE, so
 * the database merges the patch into whatever the row holds at write time. A
 * caller never sends a whole object rebuilt from an earlier read, which is the
 * stale-snapshot write that silently deleted keys added in between (a C5
 * decision, a dispute lifecycle marker, attribution).
 *
 * A key's value replaces that key's previous value whole. Keys the patch does
 * not name are untouched. `undefined` values are skipped; `null` stores JSON
 * null.
 *
 * `fields` is fenced: `purchase-fields-write-fence.test.ts` fails when app code
 * sets `purchases.fields` anywhere else.
 */
export type PurchaseFieldsPatch = Readonly<Record<string, unknown>>;

type PurchaseColumns = Omit<
  Partial<typeof purchases.$inferInsert>,
  "id" | "fields"
>;

const TOP_LEVEL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `JSON_SET(COALESCE(fields, '{}'), '$.a', ?, '$.b', ?)` for the patch.
 * Returns null when the patch names no key.
 */
export function purchaseFieldsJsonSet(patch: PurchaseFieldsPatch): SQL | null {
  const entries = Object.entries(patch).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return null;
  const pairs = entries.map(([key, value]) => {
    if (!TOP_LEVEL_KEY.test(key)) {
      throw new Error(`Invalid Purchase.fields key: ${JSON.stringify(key)}`);
    }
    return sql`${`$.${key}`}, CAST(${JSON.stringify(value)} AS JSON)`;
  });
  return sql`JSON_SET(COALESCE(${purchases.fields}, JSON_OBJECT()), ${sql.join(pairs, sql`, `)})`;
}

/**
 * Merge `patch` into one purchase's fields, optionally with other columns in
 * the same statement. `where` adds predicates that must still hold at write
 * time, which keeps compare-and-set claims atomic.
 */
export async function updatePurchaseFields(input: {
  purchaseId: string;
  patch: PurchaseFieldsPatch;
  columns?: PurchaseColumns;
  where?: SQL | undefined;
  executor?: DbExecutor;
}): Promise<{ rowsAffected: number }> {
  const fields = purchaseFieldsJsonSet(input.patch);
  const set = {
    ...input.columns,
    ...(fields ? { fields } : {}),
  };
  if (Object.keys(set).length === 0) return { rowsAffected: 0 };
  const executor = input.executor ?? db;
  const condition = eq(purchases.id, input.purchaseId);
  const result = await executor
    .update(purchases)
    .set(set)
    .where(input.where ? and(condition, input.where) : condition);
  return { rowsAffected: rowsAffectedOf(result) };
}

function rowsAffectedOf(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const record = result as Record<string, unknown>;
  const first = Array.isArray(result) ? (result[0] as unknown) : undefined;
  const header =
    first && typeof first === "object"
      ? (first as Record<string, unknown>)
      : undefined;
  return Number(
    record.rowsAffected ?? record.affectedRows ?? header?.affectedRows ?? 0,
  );
}
