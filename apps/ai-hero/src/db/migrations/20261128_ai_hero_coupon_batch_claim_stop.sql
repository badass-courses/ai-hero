ALTER TABLE `AI_CouponBatchControl`
  ADD COLUMN `claimsEnabled` int NOT NULL DEFAULT 0 AFTER `enabled`;
