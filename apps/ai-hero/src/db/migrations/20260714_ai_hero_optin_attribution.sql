ALTER TABLE `AI_Contact`
  ADD COLUMN `optInAttribution` JSON NULL;

ALTER TABLE `AI_ContactState`
  ADD COLUMN `optInAttribution` JSON NULL;
