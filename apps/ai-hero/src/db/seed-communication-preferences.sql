-- Seed communication preference types and channels for AI Hero
-- These are required for the user-created Inngest function to set up
-- newsletter preferences for new users.
--
-- Run against the ai-hero PlanetScale database:
--   pscale shell ai-hero main < src/db/seed-communication-preferences.sql
--
-- Or via the drizzle connection:
--   npx dotenv -- node -e "..." (see below)

INSERT IGNORE INTO AI_CommunicationPreferenceType (id, name, description, active, createdAt)
VALUES ('cpt_newsletter', 'Newsletter', 'Newsletter and product updates', true, NOW());

INSERT IGNORE INTO AI_CommunicationPreferenceType (id, name, description, active, createdAt)
VALUES ('cpt_ai_skills_updates', 'AI Skills Updates', 'Updates about AI skills, examples, and releases', true, NOW());

INSERT IGNORE INTO AI_CommunicationChannel (id, name, description, active, createdAt, updatedAt)
VALUES ('cc_email', 'Email', 'Email communication channel', true, NOW(), NOW());
