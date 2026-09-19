-- Creator-identity ruling (ADR §10.3).
--
-- A participant-authored private Product draft names its author in
-- `authorityCreatorParticipantId` and may not yet have a public creator identity:
-- no `mon:creator:` reference and no creator ANS Node, which is bound at governed
-- admission/publication. These two columns therefore become nullable.
--
-- Loosening only. No row is read or rewritten, no default is added, and every
-- existing non-NULL value stays exactly as it is. NULL means absence; a synthetic
-- or placeholder identity is never written in its place.

ALTER TABLE `ProductSourceRecordVersionRow`
  MODIFY `factCreatorRef`     VARCHAR(191) NULL,
  MODIFY `authorityCreatorId` VARCHAR(191) NULL;
