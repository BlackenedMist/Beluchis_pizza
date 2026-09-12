-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- Seed default store/delivery settings
INSERT INTO "Setting" ("key", "value") VALUES
    ('shop.lat', '-33.646'),
    ('shop.lng', '19.448'),
    ('delivery.freeRadiusKm', '3'),
    ('delivery.maxRadiusKm', '10'),
    ('delivery.feeAmount', '30'),
    ('delivery.enabled', 'true');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "deliveryDistance" REAL;
ALTER TABLE "Order" ADD COLUMN "deliveryFee" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "deliveryStatus" TEXT;