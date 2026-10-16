-- Separate reviewed schema deployment. Apply once after the gift-code migration.
-- Nullable correlation fields preserve old ledger rows; never rewrite history.
ALTER TABLE `AI_PurchaseDecision`
  ADD COLUMN `giftClaimId` varchar(191) DEFAULT NULL,
  ADD COLUMN `giftSlot` int DEFAULT NULL;
