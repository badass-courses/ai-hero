import type {
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";
import { z } from "zod";

export const MIN_CHECKOUT_TTL_SECONDS = 30 * 60;

export const GiftCode = z.object({
  codeRef: z.string().min(1).max(500),
  unitPrice: z.number().int().nonnegative(),
  maxUses: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  usesTaken: z.number().int().nonnegative(),
});
export type GiftCode = z.infer<typeof GiftCode>;
export type GiftFact =
  | { readonly value: GiftCode | null; readonly sourceRefs: readonly string[] }
  | { readonly gap: "FactsUnavailable" };
export const noGift = (): GiftFact => ({
  value: null,
  sourceRefs: ["gift:no-valid-cookie"],
});

const CouponRow = z.object({
  id: z.string().min(1).max(500),
  status: z.literal(1),
  maxUses: z.number().int().positive(),
  expires: z.date(),
  restrictedToProductId: z.string(),
  fields: z.object({
    purpose: z.literal("legend-gift"),
    targetPriceCents: z.number().int().nonnegative(),
    quantityLimit: z.literal(1),
    stackable: z.literal(false),
  }),
});

/** All statuses count. A refund or lost dispute cannot recycle a use. */
export async function usesTaken(
  connection: PoolConnection,
  codeRef: string,
  now: Date,
  includeExpired = false,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `
		SELECT COUNT(*) AS taken FROM (
		  SELECT purchaseId AS useId FROM AI_PurchaseDecision WHERE codeRef = ?
		  UNION ALL
		  SELECT claimId AS useId FROM AI_GiftCodeSlot s
		  WHERE s.codeRef = ? AND (s.state = 'spent' OR s.expiresAt > ? OR ?)
		  AND NOT EXISTS (SELECT 1 FROM AI_PurchaseDecision d WHERE d.codeRef = s.codeRef AND d.checkoutSessionId = s.checkoutSessionId)
		) uses`,
    [codeRef, codeRef, now, includeExpired],
  );
  const taken = Number(rows[0]?.taken);
  if (!Number.isSafeInteger(taken) || taken < 0)
    throw new Error("gift-use-count-invalid");
  return taken;
}

export async function readGiftCode(
  connection: PoolConnection,
  codeRef: string,
  productId: string,
  now: Date,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT * FROM AI_Coupon WHERE id = ? LIMIT 1",
    [codeRef],
  );
  const raw = rows[0];
  if (!raw) return null;
  let fields: unknown = raw.fields;
  if (typeof fields === "string") {
    try {
      fields = JSON.parse(fields);
    } catch {
      return null;
    }
  }
  const parsed = CouponRow.safeParse({ ...raw, fields });
  if (
    !parsed.success ||
    parsed.data.restrictedToProductId !== productId ||
    parsed.data.expires <= now
  )
    return null;
  return GiftCode.parse({
    codeRef: parsed.data.id,
    unitPrice: parsed.data.fields.targetPriceCents,
    maxUses: parsed.data.maxUses,
    expiresAt: parsed.data.expires.toISOString(),
    usesTaken: await usesTaken(connection, codeRef, now),
  });
}

export type GiftClaim = {
  codeRef: string;
  claimId: string;
  slot: number;
  expiresAt: number;
  checkoutSessionId: string | null;
};

/** Serialize contenders on the existing coupon row, then claim with one INSERT.
 * No provider call occurs in the transaction. Unbound/ambiguous claims are held
 * until reviewed, never reclaimed just because their wall clock ran out.
 */
export async function claimGiftSlot({
  connection,
  codeRef,
  productId,
  claimId,
  quantity,
  expiresAt,
  unitPrice,
  now,
}: {
  connection: PoolConnection;
  codeRef: string;
  productId: string;
  claimId: string;
  quantity: number;
  expiresAt: number;
  unitPrice: number;
  now: Date;
}): Promise<GiftClaim | null> {
  if (quantity !== 1) throw new Error("gift-quantity-must-be-one");
  await connection.beginTransaction();
  try {
    await connection.query("SELECT id FROM AI_Coupon WHERE id = ? FOR UPDATE", [
      codeRef,
    ]);
    const code = await readGiftCode(connection, codeRef, productId, now);
    if (!code || code.unitPrice !== unitPrice) {
      await connection.rollback();
      return null;
    }
    const cap = Math.min(
      expiresAt,
      Math.floor(Date.parse(code.expiresAt) / 1000),
    );
    if (cap * 1000 - now.getTime() < MIN_CHECKOUT_TTL_SECONDS * 1000) {
      await connection.rollback();
      return null;
    }
    const [previous] = await connection.query<RowDataPacket[]>(
      "SELECT * FROM AI_GiftCodeSlot WHERE claimId = ?",
      [claimId],
    );
    const old = previous[0];
    if (old) {
      if (
        old.codeRef !== codeRef ||
        old.state !== "reserved" ||
        old.expiresAt.getTime() <= now.getTime()
      )
        throw new Error("gift-claim-conflict");
      await connection.commit();
      return {
        codeRef,
        claimId,
        slot: Number(old.slot),
        expiresAt: Math.floor(old.expiresAt.getTime() / 1000),
        checkoutSessionId: old.checkoutSessionId,
      };
    }
    const taken = await usesTaken(connection, codeRef, now, true);
    if (taken >= code.maxUses) {
      await connection.rollback();
      return null;
    }
    const [slots] = await connection.query<RowDataPacket[]>(
      "SELECT slot FROM AI_GiftCodeSlot WHERE codeRef = ?",
      [codeRef],
    );
    const occupied = new Set(slots.map((row) => Number(row.slot)));
    let slot = 1;
    while (occupied.has(slot)) slot++;
    if (slot > code.maxUses) {
      await connection.rollback();
      return null;
    }
    await connection.query(
      "INSERT INTO AI_GiftCodeSlot (codeRef, slot, claimId, state, expiresAt) VALUES (?, ?, ?, ?, ?)",
      [codeRef, slot, claimId, "reserved", new Date(cap * 1000)],
    );
    await connection.commit();
    return { codeRef, claimId, slot, expiresAt: cap, checkoutSessionId: null };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function bindGiftSlot(
  connection: PoolConnection,
  claim: GiftClaim,
  sessionId: string,
) {
  const [result] = await connection.query<ResultSetHeader>(
    `UPDATE AI_GiftCodeSlot SET checkoutSessionId = ? WHERE claimId = ? AND codeRef = ? AND state = 'reserved' AND (checkoutSessionId IS NULL OR checkoutSessionId = ?)`,
    [sessionId, claim.claimId, claim.codeRef, sessionId],
  );
  if (result.affectedRows !== 1) throw new Error("gift-bind-conflict");
}

/** Only an authoritative expired event releases, and spent is terminal. */
export async function expireGiftSlot(
  connection: PoolConnection,
  sessionId: string,
) {
  await connection.query(
    "DELETE FROM AI_GiftCodeSlot WHERE checkoutSessionId = ? AND state = 'reserved'",
    [sessionId],
  );
}

/** Idempotent; a missing reservation is review-worthy, never a fulfillment veto. */
export async function spendGiftSlot(
  connection: PoolConnection,
  sessionId: string,
  codeRef: string,
  claimId?: string,
) {
  const [result] = await connection.query<ResultSetHeader>(
    "UPDATE AI_GiftCodeSlot SET state = 'spent', checkoutSessionId = ? WHERE codeRef = ? AND (checkoutSessionId = ? OR (checkoutSessionId IS NULL AND claimId = ?)) AND state IN ('reserved', 'spent')",
    [sessionId, codeRef, sessionId, claimId ?? null],
  );
  return result.affectedRows === 1;
}
