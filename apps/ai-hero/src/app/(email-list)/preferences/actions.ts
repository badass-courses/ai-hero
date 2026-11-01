"use server";

import { redirect } from "next/navigation";
import { parseEmailPreferenceKey } from "@/coursebuilder/email-preferences";
import {
  acceptKitLinkPreferenceChange,
  getEmailPreferenceDefinition,
  verifyKitPreferenceLinkLocally,
} from "@/lib/email-preferences";

/**
 * Updates a subscriber's email preference from the public preference center.
 */
export async function updateEmailPreferenceAction(formData: FormData) {
  const subscriberId = formData.get("ck_subscriber_id")?.toString();
  const shKit = formData.get("sh_kit")?.toString();
  const preferenceKey = parseEmailPreferenceKey(
    formData.get("preference")?.toString(),
  );
  const subscribed = formData.get("subscribed")?.toString() === "true";
  const preference = getEmailPreferenceDefinition(preferenceKey);

  // Kit stays out of the request. An opt-out always lands; an opt-in
  // is refused: a link cannot resubscribe anyone.
  const verification = await verifyKitPreferenceLinkLocally({
    subscriberId,
    shKit,
    source: "preferences-page",
    route: "/preferences",
  });
  const result =
    subscriberId && shKit
      ? await acceptKitLinkPreferenceChange({
          verification,
          subscriberId,
          shKit,
          preference,
          subscribed,
          source: "preferences-page",
        })
      : ({ status: "rejected", reason: "invalid-link" } as const);

  if (result.status === "rejected") {
    if (result.reason === "link-opt-in-refused") {
      redirect(
        `/preferences?${new URLSearchParams({
          ck_subscriber_id: subscriberId ?? "",
          sh_kit: shKit ?? "",
          error: "resubscribe-by-signup",
        }).toString()}`,
      );
    }
    redirect("/preferences?error=invalid-link");
  }

  redirect(
    `/preferences?${new URLSearchParams({
      ck_subscriber_id: subscriberId ?? "",
      sh_kit: shKit ?? "",
      updated: preferenceKey,
      state: subscribed ? "subscribed" : "unsubscribed",
    }).toString()}`,
  );
}
