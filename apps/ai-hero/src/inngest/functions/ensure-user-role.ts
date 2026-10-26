import { db } from "@/db";
import { userRoles } from "@/db/schema";
import { log } from "@/server/logger";
import { sql } from "drizzle-orm";

/**
 * Assigns the default `user` role. Idempotent: UserRole has a composite
 * primary key on (userId, roleId), so a retry or duplicate event is a no-op.
 */
export async function ensureUserRole({ userId }: { userId: string }) {
  const userRole = await db.query.roles.findFirst({
    where: (ur, { eq }) => eq(ur.name, "user"),
  });

  if (!userRole) {
    await log.warn("user-created.role-not-found", {
      userId,
      roleName: "user",
    });
    return;
  }

  await db
    .insert(userRoles)
    .values({ roleId: userRole.id, userId })
    .onDuplicateKeyUpdate({ set: { userId: sql`${userRoles.userId}` } });
}
