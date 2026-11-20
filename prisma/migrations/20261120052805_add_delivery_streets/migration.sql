-- CreateTable
CREATE TABLE "DeliveryStreet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "lat" REAL NOT NULL,
    "lng" REAL NOT NULL,
    "zoneId" TEXT NOT NULL,
    "wayCount" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'overpass',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DeliveryStreet_zoneId_idx" ON "DeliveryStreet"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryStreet_name_zoneId_key" ON "DeliveryStreet"("name", "zoneId");
