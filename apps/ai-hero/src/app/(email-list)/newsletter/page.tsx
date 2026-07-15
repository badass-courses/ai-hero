import React from "react";
import type { Metadata } from "next";
import { CompanyLogoGrid } from "@/components/landing/company-logo-grid";
import { HeroShader } from "@/components/landing/hero-shader";
import LayoutClient from "@/components/layout-client";
import { PrimaryNewsletterCta } from "@/components/primary-newsletter-cta";
import { PrimaryNewsletterTitle } from "@/components/subscriber-count";

const newsletterThumbnail =
  "https://res.cloudinary.com/total-typescript/image/upload/v1768313403/ai-newsletter-thumbnail_2x.jpg";

const newsletterTitle = "AI Hero Newsletter by Matt Pocock";
const newsletterDescription =
  "Subscribe to be the first to learn about AI Hero releases, updates, and special discounts for AI Heroes.";

export const metadata: Metadata = {
  title: newsletterTitle,
  description: newsletterDescription,
  alternates: {
    canonical: "/newsletter",
  },
  openGraph: {
    title: newsletterTitle,
    description: newsletterDescription,
    images: [
      {
        url: newsletterThumbnail,
        width: 1200,
        height: 630,
      },
    ],
  },
};

export default async function NewsletterPage() {
  return (
    <LayoutClient withContainer>
      <main className="relative flex min-h-[calc(100vh-var(--nav-height))] flex-col pb-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full select-none overflow-hidden"
        >
          <HeroShader
            className="absolute inset-0 opacity-50"
            speed={0.2}
            frequency={7.0}
            displacement={0.018}
            displacementFreq={4.5}
            mouseFollow={0.03}
            mouseInfluence={0.55}
            flowY={0.2}
            flowX={0.2}
            intensity={1.0}
            saturation={1.25}
            sharpness={0.7}
            grain={0.1}
            grainTexture={0.3}
            grainScale={0.5}
            chromaOffset={13.0}
            vignette={0}
            mouseHalo={0.15}
            posterize={0.1}
            colorDrift={0.05}
            seed={10}
          />
          <div className="bg-linear-to-b to-background absolute inset-0 from-transparent" />
        </div>
        <div className="relative z-10 flex flex-1 items-center justify-center">
          <PrimaryNewsletterCta
            title={<PrimaryNewsletterTitle />}
            titleElement="h1"
            trackProps={{
              event: "subscribed",
              params: {
                location: "newsletter",
              },
            }}
          />
        </div>
      </main>
      <CompanyLogoGrid />
    </LayoutClient>
  );
}
