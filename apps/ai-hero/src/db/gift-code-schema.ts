import { mysqlTable } from "@/db/mysql-table";
import {
  int,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** reserved -> spent (terminal), or reserved -> deleted after provider expiry. */
export const giftCodeSlot = mysqlTable(
  "GiftCodeSlot",
  {
    codeRef: varchar("codeRef", { length: 500 }).notNull(),
    slot: int("slot").notNull(),
    claimId: varchar("claimId", { length: 191 }).notNull(),
    checkoutSessionId: varchar("checkoutSessionId", { length: 191 }),
    state: varchar("state", { length: 16 }).notNull(),
    expiresAt: timestamp("expiresAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.codeRef, table.slot] }),
    claim: uniqueIndex("GiftCodeSlot_claim_idx").on(table.claimId),
    session: uniqueIndex("GiftCodeSlot_session_idx").on(
      table.checkoutSessionId,
    ),
  }),
);

/** Private resolution data, never copied into click metadata or client props. */
export const giftShareLink = mysqlTable("GiftShareLink", {
  slug: varchar("slug", { length: 50 }).primaryKey(),
  codeRef: varchar("codeRef", { length: 500 }).notNull(),
  firstName: varchar("firstName", { length: 100 }),
  legendId: varchar("legendId", { length: 191 }).notNull(),
});
