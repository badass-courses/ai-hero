import type { Metadata } from "next";
import Link from "next/link";
import LayoutClient from "@/components/layout-client";
import { emailPreferenceDefinitions } from "@/coursebuilder/email-preferences";
import {
  getLocalEmailPreferences,
  getSearchParamValue,
  verifyKitPreferenceLinkLocally,
} from "@/lib/email-preferences";
import type { LocalEmailPreferences } from "@/lib/email-preferences-local";
import { log } from "@/server/logger";

import { updateEmailPreferenceAction } from "./actions";

export const metadata: Metadata = {
  title: "Email Preferences",
  description: "Manage your AI Hero email preferences.",
  robots: "noindex, nofollow",
};

type PreferencesPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Renders a no-login preference center for subscribers arriving from Kit links.
 */
export default async function PreferencesPage(props: PreferencesPageProps) {
  const searchParams = await props.searchParams;
  const subscriberId = getSearchParamValue(searchParams.ck_subscriber_id);
  const shKit = getSearchParamValue(searchParams.sh_kit);
  const error = getSearchParamValue(searchParams.error);
  const updatedPreference = getSearchParamValue(searchParams.updated);
  const updatedState = getSearchParamValue(searchParams.state);

  const resubscribeRefused = error === "resubscribe-by-signup";

  const { subscriber, preferences } = await readLocalView(subscriberId, shKit);

  return (
    <LayoutClient withContainer>
      <main className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-2xl flex-col justify-center px-5 py-16">
        <div className="space-y-8">
          <div className="space-y-3 text-center">
            <p className="text-muted-foreground text-sm font-medium uppercase tracking-wide">
              AI Hero
            </p>
            <h1 className="font-heading text-3xl font-bold">
              Email preferences
            </h1>
            <p className="text-muted-foreground">
              Pick the emails you want from us. You can change this any time.
            </p>
          </div>

          {(error && !resubscribeRefused) || !subscriber || !preferences ? (
            <div className="border-border bg-muted/30 rounded-lg border p-5 text-center">
              <h2 className="font-heading text-xl font-semibold">
                We need the link from your email
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                Click &ldquo;manage preferences&rdquo; at the bottom of any AI
                Hero email and you&apos;ll land back here, no login needed.
              </p>
              <Link
                href="/"
                className="text-primary mt-4 inline-flex text-sm font-medium hover:underline"
              >
                Back to AI Hero
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {resubscribeRefused ? <ResubscribeExplainer /> : null}
              {updatedPreference && updatedState ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                  Saved. Your{" "}
                  {emailPreferenceDefinitions.find(
                    (preference) => preference.key === updatedPreference,
                  )?.name ?? "email"}{" "}
                  setting is updated.
                </div>
              ) : null}

              <div className="divide-border overflow-hidden rounded-lg border">
                {emailPreferenceDefinitions.map((preference) => {
                  const state = preferences[preference.key];
                  // Unknown is never shown as subscribed, and only offers a stop.
                  const subscribed = state.known ? state.subscribed : false;

                  return (
                    <div
                      key={preference.key}
                      className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <h2 className="font-heading text-lg font-semibold">
                          {preference.name}
                        </h2>
                        <p className="text-muted-foreground text-sm">
                          {preference.description}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {!state.known
                            ? "We couldn't load this setting right now."
                            : state.stoppedEverything
                              ? "You've unsubscribed from all AI Hero email."
                              : subscribed
                                ? "You're getting these."
                                : "You're not getting these."}
                        </p>
                      </div>
                      {state.known && state.stoppedEverything ? null : !(
                          subscribed || !state.known
                        ) ? (
                        <ResubscribeLink />
                      ) : (
                        <form action={updateEmailPreferenceAction}>
                          <input
                            type="hidden"
                            name="ck_subscriber_id"
                            value={subscriberId}
                          />
                          <input type="hidden" name="sh_kit" value={shKit} />
                          <input
                            type="hidden"
                            name="preference"
                            value={preference.key}
                          />
                          <input
                            type="hidden"
                            name="subscribed"
                            value={
                              subscribed || !state.known ? "false" : "true"
                            }
                          />
                          <button
                            type="submit"
                            className="border-border bg-background hover:bg-hover rounded-md border px-4 py-2 text-sm font-medium transition"
                          >
                            {subscribed || !state.known
                              ? "Stop these"
                              : "Send me these"}
                          </button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </main>
    </LayoutClient>
  );
}

function ResubscribeLink() {
  return (
    <Link
      href="/newsletter"
      className="border-border bg-background hover:bg-hover rounded-md border px-4 py-2 text-sm font-medium transition"
    >
      Sign up again
    </Link>
  );
}

/** An email link can stop mail, never restart it: resubscribing needs a login. */
function ResubscribeExplainer() {
  return (
    <div className="border-border bg-muted/30 rounded-lg border p-4 text-sm">
      <p className="text-muted-foreground">
        An email link can only unsubscribe you. To get these emails again, sign
        up again and confirm from the email we send.
      </p>
      <Link
        href="/newsletter"
        className="text-primary mt-2 inline-flex font-medium hover:underline"
      >
        Sign up again
      </Link>
    </div>
  );
}

type PreferenceView = {
  subscriber: unknown;
  preferences: LocalEmailPreferences | null;
};

/**
 * Local view, Kit out of the request: the link checked against the
 * directory, state from local evidence and drovr stops. A link that cannot
 * be checked right now still lists every preference as unknown, with a stop.
 */
async function readLocalView(
  subscriberId: string | undefined,
  shKit: string | undefined,
): Promise<PreferenceView> {
  const verification = await verifyKitPreferenceLinkLocally({
    subscriberId,
    shKit,
    source: "preferences-page",
    route: "/preferences",
  });
  const preferences =
    verification.status === "invalid"
      ? null
      : await getLocalEmailPreferences(verification);

  await log.info("email-preferences.view", {
    source: "preferences-page",
    provider: "local-directory",
    kitSubscriberId: subscriberId,
    result: verification.status,
  });

  return { subscriber: preferences ? verification : null, preferences };
}
