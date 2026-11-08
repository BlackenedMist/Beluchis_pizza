-- Drop the old unique constraint (specialId, itemId) and replace with
-- (specialId, itemId, sizeLabel) so the same item can appear in multiple
-- sizes within one bundle special.
DROP INDEX IF EXISTS "SpecialItem_specialId_itemId_key";
CREATE UNIQUE INDEX "SpecialItem_specialId_itemId_sizeLabel_key" ON "SpecialItem"("specialId", "itemId", "sizeLabel");
