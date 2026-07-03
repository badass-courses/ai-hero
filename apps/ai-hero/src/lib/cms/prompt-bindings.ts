import type { Prompt, PromptSchema } from "@/lib/prompts";
import { updatePrompt } from "@/lib/prompts-query";

import type { ResourceAction, ResourceBindings } from "@coursebuilder/ui/cms/manifest";
import { stripClientPublishedAt } from "@coursebuilder/ui/cms/resource-state";

/**
 * Server bindings for the cms prompt editor (`createResourceEditor`).
 *
 * Mirrors `createWorkshopBindings`: a thin factory whose one verb maps onto
 * the REAL server action the legacy `EditPromptForm` used (`updatePrompt`,
 * single-arg upsert — no action param). Prompts are the lightest type: no
 * tags, lists, media, contents, or parents — the legacy form passed no tools
 * at all, so nothing else is wired here.
 */
export interface CreatePromptBindingsOptions {
  /**
   * Called after a save whose slug differs from the last-saved slug.
   * Parity with the reference forms: redirect to the new edit URL.
   */
  onSlugChange?: (slug: string) => void;
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb
 * (`updatePrompt` has no action param — state is just a field).
 */
function stateForAction(
  action: ResourceAction,
  current: Prompt["fields"]["state"],
): Prompt["fields"]["state"] {
  switch (action) {
    case "publish":
      return "published";
    case "archive":
      return "archived";
    case "unpublish":
      return "draft";
    default:
      return current;
  }
}

export function createPromptBindings({
  onSlugChange,
}: CreatePromptBindingsOptions = {}): ResourceBindings<typeof PromptSchema> {
  return {
    update: async (values, action) => {
      if (!values.id || !values.fields) {
        throw new Error("Invalid resource data");
      }
      // NOTE: updatePrompt regenerates the slug itself on title change (with
      // a known latent quirk: it splits the existing slug on '-' instead of
      // '~'). Server behavior is preserved as-is — the redirect below reads
      // the slug the SERVER returns, so the editor lands wherever the server
      // actually put the prompt.
      const updated = await updatePrompt({
        ...values,
        fields: {
          ...stripClientPublishedAt(values.fields),
          state: stateForAction(action, values.fields.state || "draft"),
        },
      });
      // null here means nothing was persisted — don't let the kit report 'Saved'.
      if (updated == null) {
        throw new Error("Prompt save failed — nothing was persisted");
      }
      return updated;
    },
    onSave: async (resource, hasNewSlug) => {
      const slug = resource?.fields?.slug;
      if (hasNewSlug && slug) {
        onSlugChange?.(slug);
      }
    },
    getResourcePath: (slug) => `/prompts/${slug || ""}`,
    // NO media / listVideos / videoLibrary bindings — deliberately. The
    // Media tab and "Video…" insert produce MDX snippets (`<Image …/>`,
    // `<Video …/>`), but the public prompt page renders `fields.body` with
    // ReactMarkdown, which drops those tags — authors would save content
    // that looks fine in the editor and renders broken on the site. The
    // manifest's `media: {}` only lights the tab up when these bindings
    // exist, so omitting them keeps the editor to ReactMarkdown-safe syntax.
  };
}
