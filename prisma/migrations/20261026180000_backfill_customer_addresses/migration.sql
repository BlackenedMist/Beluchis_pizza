-- Backfill one "Home" CustomerAddress for customers that have a legacy
-- addressLabel but no saved locations yet, so they are not locked out of
-- delivery after the storefront moved to saved-locations-only.
INSERT INTO "CustomerAddress" ("customerId", "label", "address", "lat", "lng", "isDefault", "createdAt", "updatedAt")
SELECT c."id",
       'Home',
       TRIM(c."addressLabel"),
       c."lat",
       c."lng",
       1,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "Customer" c
WHERE COALESCE(TRIM(c."addressLabel"), '') <> ''
  AND NOT EXISTS (SELECT 1 FROM "CustomerAddress" a WHERE a."customerId" = c."id");
