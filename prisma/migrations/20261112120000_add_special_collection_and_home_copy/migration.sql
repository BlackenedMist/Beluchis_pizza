-- Collection-only specials + owner-authored home page copy.
ALTER TABLE "Special" ADD COLUMN "collectionOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Special" ADD COLUMN "homeHeadline" TEXT;
ALTER TABLE "Special" ADD COLUMN "homeSubtext" TEXT;
ALTER TABLE "Special" ADD COLUMN "homeBadge" TEXT;
ALTER TABLE "Special" ADD COLUMN "homePriceText" TEXT;
