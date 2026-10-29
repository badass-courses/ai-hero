import { describe, expect, it } from "vitest";

import { partitionDiscordRoleRemovals } from "./discord-role-retention";

const ROLE_CC = "role-cc";
const ROLE_OTHER = "role-other";

const ent = (
  id: string,
  sourceId: string,
  discordRoleId: string,
  sourceType = "PURCHASE",
) => ({ id, sourceType, sourceId, metadata: { discordRoleId } });

describe("partitionDiscordRoleRemovals", () => {
  it("keeps the role when a live entitlement from another purchase grants it", () => {
    const result = partitionDiscordRoleRemovals({
      refundedPurchaseId: "p-cc",
      refundedEntitlements: [ent("e1", "p-cc", ROLE_CC)],
      liveEntitlements: [ent("e2", "p-c5", ROLE_CC)],
    });
    expect(result.remove).toEqual([]);
    expect(result.keep).toEqual([
      { entitlementId: "e1", discordRoleId: ROLE_CC },
    ]);
  });

  it("removes the role when nothing else grants it", () => {
    const result = partitionDiscordRoleRemovals({
      refundedPurchaseId: "p-cc",
      refundedEntitlements: [ent("e1", "p-cc", ROLE_CC)],
      liveEntitlements: [ent("e3", "p-x", "unrelated-role")],
    });
    expect(result.remove).toEqual([
      { entitlementId: "e1", discordRoleId: ROLE_CC },
    ]);
    expect(result.keep).toEqual([]);
  });

  it("decides each role separately", () => {
    const result = partitionDiscordRoleRemovals({
      refundedPurchaseId: "p-cc",
      refundedEntitlements: [
        ent("e1", "p-cc", ROLE_CC),
        ent("e2", "p-cc", ROLE_OTHER),
      ],
      liveEntitlements: [ent("e3", "sub-1", ROLE_CC, "SUBSCRIPTION")],
    });
    expect(result.keep.map((k) => k.discordRoleId)).toEqual([ROLE_CC]);
    expect(result.remove.map((r) => r.discordRoleId)).toEqual([ROLE_OTHER]);
  });

  it("ignores the refunded purchase's own entitlements as live grants", () => {
    const result = partitionDiscordRoleRemovals({
      refundedPurchaseId: "p-cc",
      refundedEntitlements: [ent("e1", "p-cc", ROLE_CC)],
      liveEntitlements: [ent("e1", "p-cc", ROLE_CC)],
    });
    expect(result.keep).toEqual([]);
    expect(result.remove).toHaveLength(1);
  });
});
