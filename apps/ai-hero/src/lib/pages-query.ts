"use server";

import { revalidateTag, unstable_cache } from "next/cache";
import { courseBuilderAdapter, db } from "@/db";
import { contentResource, contentResourceResource } from "@/db/schema";
import { NewPage, Page, PageSchema } from "@/lib/pages";
import { getServerAuthSession } from "@/server/auth";
import { log } from "@/server/logger";
import { publishedAtStamp } from "@coursebuilder/ui/cms/resource-state";
import { guid } from "@coursebuilder/utils/guid";
import slugify from "@sindresorhus/slugify";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { z } from "zod";

import { retryTransientDatabaseRead } from "./transient-database-read";

export async function getPages(): Promise<Page[]> {
  const { ability } = await getServerAuthSession();

  const visibility: ("public" | "private" | "unlisted")[] = ability.can("update", "Content")
    ? ["public", "private", "unlisted"]
    : ["public"];
  const states: ("draft" | "published")[] = ability.can("update", "Content")
    ? ["draft", "published"]
    : ["published"];

  const pages = await db.query.contentResource.findMany({
    where: and(
      eq(contentResource.type, "page"),
      inArray(sql`JSON_EXTRACT (${contentResource.fields}, "$.visibility")`, visibility),
      inArray(sql`JSON_EXTRACT (${contentResource.fields}, "$.state")`, states),
    ),
    orderBy: desc(contentResource.createdAt),
  });

  const pagesParsed = z.array(PageSchema).safeParse(pages);
  if (!pagesParsed.success) {
    void log.error("page.parse.error", {
      scope: "pages",
      error: pagesParsed.error.message,
    });
    return [];
  }

  return pagesParsed.data;
}

export async function createPage(input: NewPage) {
  const { session, ability } = await getServerAuthSession();
  const user = session?.user;
  if (!user || !ability.can("create", "Content")) {
    throw new Error("Unauthorized");
  }

  const newPageId = v4();

  await db.insert(contentResource).values({
    id: newPageId,
    type: "page",
    fields: {
      title: input.fields.title,
      state: "draft",
      visibility: "unlisted",
      slug: slugify(`${input.fields.title}~${guid()}`),
    },
    createdById: user.id,
  });

  const page = await getPage(newPageId);

  revalidateTag("pages", "max");

  return page;
}

export async function updatePage(input: Page) {
  const { session, ability } = await getServerAuthSession();
  const user = session?.user;
  if (!user || !ability.can("update", "Content")) {
    throw new Error("Unauthorized");
  }

  const currentPage = await getPage(input.id);

  if (!currentPage) {
    return createPage(input);
  }

  // Slugs are intentionally NOT regenerated when the title changes — only an
  // explicit edit to the slug field changes the slug.
  const pageSlug = input.fields.slug ?? currentPage.fields.slug;

  const updated = await courseBuilderAdapter.updateContentResourceFields({
    id: currentPage.id,
    fields: {
      ...currentPage.fields,
      ...input.fields,
      slug: pageSlug,
      // Stamp fields.publishedAt on the transition INTO 'published' (or
      // backfill a missing stamp) — same policy as updatePost.
      ...publishedAtStamp(input.fields.state, currentPage.fields),
    },
  });

  // Match the legacy /api/pages route: every save invalidates cached page
  // listings/detail pages, otherwise edits serve stale content until an
  // unrelated invalidation.
  revalidateTag("pages", "max");

  return updated;
}

export async function getPage(slugOrId: string) {
  const page = await db.query.contentResource.findFirst({
    where: and(
      or(
        eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
        eq(contentResource.id, slugOrId),
      ),
      eq(contentResource.type, "page"),
    ),
    with: {
      resources: {
        with: {
          resource: {
            with: {
              tags: {
                with: {
                  tag: true,
                },
              },
            },
          },
        },
        orderBy: asc(contentResourceResource.position),
      },
    },
  });

  const pageParsed = PageSchema.safeParse(page);
  if (!pageParsed.success) {
    void log.error("page.parse.error", {
      scope: "page",
      slugOrId,
      error: pageParsed.error.message,
    });
    return null;
  }

  return pageParsed.data;
}

const _getCachedPage = unstable_cache(
  async (slugOrId: string) => retryTransientDatabaseRead(() => getPage(slugOrId)),
  ["pages-v1"],
  {
    revalidate: 3600,
    tags: ["pages"],
  },
);

/** Public CMS page loader for static and ISR surfaces. */
export async function getCachedPage(slugOrId: string) {
  const result = await _getCachedPage(slugOrId);
  if (!result) return null;

  const parsed = PageSchema.safeParse(reviveDates(result));
  return parsed.success ? parsed.data : null;
}

function reviveDates(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, reviveDates(nested)]),
    );
  }
  return value;
}
