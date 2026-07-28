import * as React from "react";
import Link from "next/link";
import { ResourceRow } from "@/components/landing/resource-row";
import { TYPE } from "@/components/landing/type";
import { cn } from "@coursebuilder/utils/cn";
import type { MapTocItem } from "@/components/navigation/map-toc";
import { MapQuestionGrid } from "@/components/navigation/map-toc";
import { AskAIHeroBotCard } from "@/components/navigation/ask-ai-hero-bot-card";
import type { GoalSection } from "@/components/navigation/goal-sections-data";
import { PrimaryNewsletterCta } from "@/components/primary-newsletter-cta";
import { PrimaryNewsletterTitle } from "@/components/subscriber-count";
import type { ResolvedItem } from "@/lib/goal-sections-query";

import { SkillCard } from "@/components/skills/skill-card";

import { MoreWaysLink } from "./more-ways-link";

/**
 * MapPage — presentational composition for the `/learn` Map page (W3, spec §3).
 *
 * Pure server component: every piece of data (resolved goal-section items,
 * What's New posts) is fetched up front in `page.tsx` and passed as props. The
 * only client interactivity lives inside `MapQuestionGrid` (active-section
 * observer), `AskAIHeroBotCard` and `PrimaryNewsletterCta`.
 *
 * NO breadcrumbs (deliberate — the Map is a wayfinding layer, not a hierarchy).
 * NO section background tints — typography and whitespace differentiate goals.
 */

/** A goal section with its item refs already resolved to real posts (config order, unresolved dropped). */
export interface ResolvedGoalSection {
  section: GoalSection;
  items: ResolvedItem[];
}

export interface MapPageProps {
  /** Goal sections with resolved item cards, in config order. */
  goalSections: ResolvedGoalSection[];
  /** Most-recent published posts for the What's New featured row. */
  whatsNew: ResolvedItem[];
  /** Flat anchor-TOC entries (one per goal section). */
  tocItems: MapTocItem[];
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/**
 * "Video · 12 min" style meta from a resolved item.
 *
 * `isVideo` wins over `type`: a post carrying a video is stored as an article,
 * and the row used to show a VIDEO badge next to the word ARTICLE, which reads
 * as a bug rather than as two facts.
 */
function metaLabel(item: ResolvedItem): string {
  const parts: string[] = [];
  if (item.isVideo) parts.push("Video");
  else if (item.type) parts.push(capitalize(item.type));
  if (item.durationLabel) parts.push(item.durationLabel);
  return parts.join(" · ");
}

/**
 * One list row for a resolved item — the spec's `.ah-row` card. Hub-sidebar
 * pages use lists, never multi-column grids: the content column is too narrow
 * (DESIGN / decisions.md "Hub-sidebar pages use lists, not grids").
 *
 * Compact rather than the landing page's full-bleed row: a question here has
 * up to a dozen answers under it, and at full-bleed height the reader sees
 * three and stops reading it as a list.
 */
function ItemRow({ item, summary }: { item: ResolvedItem; summary?: string }) {
  return (
    <ResourceRow
      compact
      title={item.title}
      description={summary ?? item.description ?? undefined}
      href={item.href}
      image={item.thumbnailUrl ?? undefined}
      typeLabel={metaLabel(item) || undefined}
      fallbackPlaceholder={item.type ? capitalize(item.type) : undefined}
    />
  );
}

function GoalSectionBlock({ goal }: { goal: ResolvedGoalSection }) {
  const { section, items } = goal;
  return (
    <section
      id={section.id}
      data-goal-section
      className="border-b scroll-mt-24"
    >
      {/* Text keeps the side padding; the row list bleeds full-width to the
			    container edges (DESIGN rule 1), like the landing rows. */}
      <div className="flex flex-col">
        <div className="flex flex-col gap-3 px-8 pb-8 pt-16 sm:px-11">
          <h2 className={cn(TYPE.heading, "text-balance")}>
            {section.question}
          </h2>
          <p className={cn(TYPE.lead, "text-muted-foreground max-w-[64ch]")}>
            {section.strapline}
          </p>
        </div>

        <ul className="flex flex-col gap-2.5 px-8 sm:px-11">
          {items.map((item) => (
            <li key={item.slug}>
              <ItemRow item={item} />
            </li>
          ))}
        </ul>

        {/* Footer: the signature "open" affordance for the whole topic. The
				    skill, where one matches, gets a real card rather than a sentence
				    in a box — the slash command is the token readers recognise. */}
        <div className="flex flex-col gap-6 px-8 py-8 sm:px-11">
          <MoreWaysLink href={section.moreHref} label={section.moreLabel} />
          {section.skillCta ? (
            <SkillCard
              slug={section.skillCta.href.replace(/^\//, "")}
              label="Do this with"
              className="sm:max-w-xl"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WhatsNewSection({ items }: { items: ResolvedItem[] }) {
  if (items.length === 0) return null;
  return (
    // `data-goal-section` is the hook MapToc's IntersectionObserver watches,
    // so carrying it here is what lets the TOC highlight this entry on the way
    // past. The attribute names the observer's contract, not a claim that this
    // is a goal.
    <section
      id="whats-new"
      data-goal-section
      className="border-b scroll-mt-24"
    >
      {/* Same rhythm as GoalSectionBlock: the section itself has no padding so
          the row list can bleed to the container's edges, and the head block
          carries the vertical space. It used to set py-16/md:py-24 on the
          section AND gaps inside, which stacked into a much taller band than
          its neighbours. */}
      <div className="flex flex-col">
        <div className="flex flex-wrap items-end justify-between gap-4 px-8 pb-8 pt-16 sm:px-11">
          <div className="flex flex-col gap-2">
            <p
              className={cn(TYPE.micro, "text-[color:var(--ah-fg-label)]")}
            >
              What&rsquo;s New
            </p>
            <h2 className={TYPE.heading}>Fresh from the blog</h2>
          </div>
          <Link
            href="/posts"
            className={cn(
              TYPE.meta,
              "text-foreground/70 hover:text-foreground focus-visible:ring-ring transition-colors focus-visible:outline-none focus-visible:ring-2",
            )}
          >
            See all posts →
          </Link>
        </div>

        <div className="pb-8">
          {items.map((item) => (
            <ItemRow key={item.slug} item={item} summary={item.summary} />
          ))}
        </div>
      </div>
    </section>
  );
}

export function MapPage({
  goalSections,
  whatsNew,
  tocItems,
}: MapPageProps) {
  return (
    <div>
      {/* Hero — single column (the hub content column is too narrow for a
			    two-up split). Newsletter lives at the bookend below. */}
      <section id="top" className="border-b">
        <div className="flex flex-col gap-6 px-8 py-16 sm:px-11 md:py-24">
          <p className={cn(TYPE.micro, "text-[color:var(--ah-fg-label)]")}>
            The Map
          </p>
          <h1 className={cn(TYPE.title, "text-balance max-w-[24ch]")}>
            What would you like to do with AI coding?
          </h1>
          <p className={cn(TYPE.lead, "text-muted-foreground max-w-[64ch]")}>
            Pick the question that sounds like you. Each one opens onto the
            articles, videos, and skills that answer it, in the order they make
            sense.
          </p>

          {/* The questions themselves are the offer, so they sit in the hero
				      rather than in a TOC block below it. */}
          <MapQuestionGrid items={tocItems} className="mt-2" />

          {/* The bot lives in the sidebar, which is desktop-only — so the
				      reader none of the four questions fits still gets it on a phone. */}
          <AskAIHeroBotCard className="mt-2 max-w-[380px] md:hidden" />
        </div>
      </section>

      {/* Goal sections */}
      {goalSections.map((goal) => (
        <GoalSectionBlock key={goal.section.id} goal={goal} />
      ))}

      {/* What's New featured row */}
      <WhatsNewSection items={whatsNew} />

      {/* Bookend CTA */}
      <section>
        <div className="py-16 md:py-24">
          <PrimaryNewsletterCta
            title={<PrimaryNewsletterTitle />}
            titleElement="h2"
            trackProps={{ event: "learn_bookend_newsletter" }}
          />
        </div>
      </section>
    </div>
  );
}
