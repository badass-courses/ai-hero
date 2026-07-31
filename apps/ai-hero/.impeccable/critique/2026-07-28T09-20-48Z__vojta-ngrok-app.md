---
timestamp: 2026-07-28T09-20-48Z
slug: vojta-ngrok-app
---
{
  "target": "https://vojta.ngrok.app/",
  "score": 22,
  "maxScore": 40,
  "heuristics": [
    {"id": 1, "name": "Visibility of System Status", "score": 3},
    {"id": 2, "name": "Match System / Real World", "score": 2},
    {"id": 3, "name": "User Control and Freedom", "score": 3},
    {"id": 4, "name": "Consistency and Standards", "score": 1},
    {"id": 5, "name": "Error Prevention", "score": 2},
    {"id": 6, "name": "Recognition Rather Than Recall", "score": 2},
    {"id": 7, "name": "Flexibility and Efficiency", "score": 3},
    {"id": 8, "name": "Aesthetic and Minimalist Design", "score": 2},
    {"id": 9, "name": "Error Recovery", "score": 2},
    {"id": 10, "name": "Help and Documentation", "score": 2}
  ],
  "findings": [
    {"id": "p0-placeholders", "severity": "p0", "title": "PLACEHOLDER testimonial copy live on page", "location": "content/landing.md"},
    {"id": "p1-cycle-ring", "severity": "p1", "title": "Skill cycle: no Phase 2, unphased skills inside the ring, two empty grid cells", "location": "src/components/skills/skill-cycle.tsx:130-192"},
    {"id": "p1-cohort-orphan", "severity": "p1", "title": "Live cohort heading renders over empty space (UpcomingCohort returns null)", "location": "src/components/landing/upcoming-cohort.tsx:9-12"},
    {"id": "p1-design-md", "severity": "p1", "title": "Skills section violates DESIGN.md rules 1, 3 and 12 (inset from container border-x, off-scale padding, double hairline)", "location": "src/components/landing/skill-cycle-section.tsx:27"},
    {"id": "p2-mono-label", "severity": "p2", "title": "Mono micro-label used ~14 ways including the primary CTA; AND REPEAT fails contrast at opacity-40", "location": "src/components/skills/skill-cycle.tsx:270,436"},
    {"id": "p2-newsletter-1", "severity": "p2", "title": "First newsletter ask has no heading, proposition or subscriber count", "location": "content/landing.md:27"},
    {"id": "p2-taxonomy", "severity": "p2", "title": "Homepage phases vs /skills named groups: two taxonomies for the same 21 objects", "location": "src/components/skills/skill-cycle.tsx"},
    {"id": "p3-emdash", "severity": "p3", "title": "Em dashes in copy, banned by DESIGN.md", "location": "content/landing.md"},
    {"id": "p3-nested-section", "severity": "p3", "title": "Redundant section wrapper around CompanyLogoGrid which renders its own section", "location": "src/app/page.tsx:132"}
  ]
}
