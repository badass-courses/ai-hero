"use server";

import { redirect } from "next/navigation";
import { resolveUnsubscribePreference } from "@/coursebuilder/email-preferences";
import { env } from "@/env.mjs";
import {
  acceptKitLinkPreferenceChange,
  getEmailPreferenceDefinition,
  syncLocalEmailPreference,
  unsubscribeLocalEmailPreferenceByUserId,
  updateProviderEmailPreference,
  validateKitPreferenceIdentity,
  verifyKitPreferenceLinkLocally,
} from "@/lib/email-preferences";
import { emailPreferencesLocalEnabled } from "@/lib/email-preferences-local";
import { log } from "@/server/logger";

export type UnsubscribeActionState = { status: "idle" | "done" };

const readField = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" && value ? value : undefined;
};

/**
 * The only place /unsubscribed writes. Opening the page changes nothing;
 * pressing the button posts here. Identity is re-validated from the form
 * fields, so nothing is trusted beyond what the server checks itself.
 */
export async function unsubscribeAction(
  _previous: UnsubscribeActionState,
  formData: FormData,
): Promise<UnsubscribeActionState> {
  const subscriberId = readField(formData, "ck_subscriber_id");
  const shKit = readField(formData, "sh_kit");
  const userId = readField(formData, "userId");
  const resolution = resolveUnsubscribePreference(
    readField(formData, "preference"),
  );

  // Only a known preference may write. Unknown or cohort values never fall
  // back to the newsletter all-stop.
  if (resolution.kind !== "known") {
    redirect("/");
  }

  const preferenceKey = resolution.key;
  const preferenceDefinition = getEmailPreferenceDefinition(preferenceKey);

  if (subscriberId && shKit && emailPreferencesLocalEnabled(env)) {
    // Kit stays out of the request: the directory checks the link, and an
    // opt-out that cannot be checked now is queued and still lands.
    const verification = await verifyKitPreferenceLinkLocally({
      subscriberId,
      shKit,
      source: "unsubscribe-link",
      route: "/unsubscribed",
    });
    const result = await acceptKitLinkPreferenceChange({
      verification,
      subscriberId,
      shKit,
      preference: preferenceDefinition,
      subscribed: false,
      source: "unsubscribe-link",
    });

    if (result.status === "rejected") {
      redirect("/");
    }
  } else if (subscriberId && shKit) {
    const subscriber = await validateKitPreferenceIdentity({
      subscriberId,
      shKit,
      source: "unsubscribe-link",
      route: "/unsubscribed",
    });

    if (!subscriber) {
      redirect("/");
    }

    const state = await updateProviderEmailPreference({
      subscriberId,
      subscriberEmail: subscriber.email_address ?? undefined,
      preference: preferenceDefinition,
      subscribed: false,
      source: "unsubscribe-link",
    });

    await syncLocalEmailPreference({
      email: subscriber.email_address,
      preference: preferenceDefinition,
      subscribed: state.subscribed,
      source: "unsubscribe-link",
    });

    await log.info("email-preferences.unsubscribe", {
      source: "unsubscribe-link",
      provider: "convertkit",
      kitSubscriberId: subscriberId,
      shKit,
      preferenceKey,
      result: state.status,
    });
  } else {
    if (!userId) {
      redirect("/");
    }

    const result = await unsubscribeLocalEmailPreferenceByUserId({
      userId,
      preference: preferenceDefinition,
      source: "unsubscribe-link",
    });

    if (!result) {
      redirect("/");
    }

    await log.info("email-preferences.unsubscribe", {
      source: "unsubscribe-link",
      provider: "local-db",
      userId: result.userId,
      preferenceKey,
      result: "unsubscribed",
    });
  }

  return { status: "done" };
}
