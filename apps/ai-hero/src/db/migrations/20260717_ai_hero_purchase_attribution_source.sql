ALTER TABLE `AI_GoogleAdsConversionUpload`
  ADD COLUMN `attributionSource` varchar(40) NOT NULL DEFAULT 'checkout'
  AFTER `clickIdHash`;
