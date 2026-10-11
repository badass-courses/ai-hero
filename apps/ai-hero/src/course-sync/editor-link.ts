import { eq } from "drizzle-orm";

import { db } from "@/db";
import { contentResource } from "@/db/schema";
import { env } from "@/env.mjs";

import { courseSyncHistoryPermalink } from "./detection-poller";
import { anchorResourceId, type CourseSyncBinding } from "./types";

export type CourseSyncEditorLink = { url: string; label: string };

export type CourseSyncAnchorSlugLookup = (
  anchorResourceId: string,
) => Promise<string | null>;

export async function lookupAnchorResourceSlug(
  resourceId: string,
): Promise<string | null> {
  const resource = await db.query.contentResource.findFirst({
    where: eq(contentResource.id, resourceId),
  });
  const slug = (resource?.fields as { slug?: unknown } | null | undefined)
    ?.slug;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

/**
 * Where the success notice's editor link points. It follows the run's binding:
 * a workshop binding edits its anchor workshop, a cohort binding edits its
 * anchor cohort. When the anchor slug cannot be resolved the link falls back to
 * the run page the notice already carries, never to another course's editor.
 */
export async function resolveCourseSyncEditorLink(
  binding: CourseSyncBinding,
  courseVersionId: string,
  lookupSlug: CourseSyncAnchorSlugLookup = lookupAnchorResourceSlug,
): Promise<CourseSyncEditorLink> {
  const fallback = {
    url: courseSyncHistoryPermalink(courseVersionId),
    label: "Open the sync run",
  };
  const slug = await lookupSlug(anchorResourceId(binding)).catch(() => null);
  if (!slug) return fallback;
  const isWorkshop = binding.contractVersion === 4;
  return {
    url: new URL(
      `/${isWorkshop ? "workshops" : "cohorts"}/${encodeURIComponent(slug)}/edit`,
      env.NEXT_PUBLIC_URL,
    ).toString(),
    label: isWorkshop ? "Open the workshop editor" : "Open the cohort editor",
  };
}
