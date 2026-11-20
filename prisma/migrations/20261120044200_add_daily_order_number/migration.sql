-- CreateTable
CREATE TABLE "ShopConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "fbPageId" TEXT,
    "fbToken" TEXT,
    "igUserId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'network',
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 9100,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customerId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'placed',
    "paymentMethod" TEXT NOT NULL DEFAULT 'cod_cash',
    "paymentStatus" TEXT NOT NULL DEFAULT 'pending',
    "payRef" TEXT,
    "payRequestId" TEXT,
    "txnId" TEXT,
    "resultCode" TEXT,
    "resultDesc" TEXT,
    "total" INTEGER NOT NULL,
    "discountCode" TEXT,
    "discountLabel" TEXT,
    "discountAmount" INTEGER NOT NULL DEFAULT 0,
    "grandTotal" INTEGER,
    "deliveryLat" REAL,
    "deliveryLng" REAL,
    "deliveryAddress" TEXT,
    "deliveryDistance" REAL,
    "deliveryFee" INTEGER NOT NULL DEFAULT 0,
    "tipAmount" INTEGER NOT NULL DEFAULT 0,
    "deliveryStatus" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dayKey" TEXT,
    "dailyNumber" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("createdAt", "customerId", "deliveryAddress", "deliveryDistance", "deliveryFee", "deliveryLat", "deliveryLng", "deliveryStatus", "discountAmount", "discountCode", "discountLabel", "grandTotal", "id", "notes", "payRef", "payRequestId", "paymentMethod", "paymentStatus", "resultCode", "resultDesc", "status", "tipAmount", "total", "txnId") SELECT "createdAt", "customerId", "deliveryAddress", "deliveryDistance", "deliveryFee", "deliveryLat", "deliveryLng", "deliveryStatus", "discountAmount", "discountCode", "discountLabel", "grandTotal", "id", "notes", "payRef", "payRequestId", "paymentMethod", "paymentStatus", "resultCode", "resultDesc", "status", "tipAmount", "total", "txnId" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
CREATE INDEX "Order_dayKey_idx" ON "Order"("dayKey");
CREATE TABLE "new_Special" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'flat',
    "categoryId" INTEGER,
    "sizeLabel" TEXT,
    "count" INTEGER NOT NULL DEFAULT 2,
    "buyCount" INTEGER NOT NULL DEFAULT 0,
    "payCount" INTEGER NOT NULL DEFAULT 0,
    "selectionMode" TEXT NOT NULL DEFAULT '',
    "payMode" TEXT NOT NULL DEFAULT 'expensive',
    "bundleSpec" TEXT,
    "exemptFromDeals" BOOLEAN NOT NULL DEFAULT true,
    "collectionOnly" BOOLEAN NOT NULL DEFAULT false,
    "homeDisplay" TEXT NOT NULL DEFAULT 'tile',
    "homeHeadline" TEXT,
    "homeSubtext" TEXT,
    "homeBadge" TEXT,
    "homePriceText" TEXT,
    "weekdays" TEXT,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "imageUrl" TEXT,
    "showOnHome" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Special_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Special" ("bundleSpec", "categoryId", "collectionOnly", "count", "createdAt", "description", "exemptFromDeals", "homeBadge", "homeHeadline", "homePriceText", "homeSubtext", "id", "imageUrl", "isActive", "kind", "name", "price", "showOnHome", "sizeLabel", "sortOrder", "updatedAt") SELECT "bundleSpec", "categoryId", "collectionOnly", "count", "createdAt", "description", "exemptFromDeals", "homeBadge", "homeHeadline", "homePriceText", "homeSubtext", "id", "imageUrl", "isActive", "kind", "name", "price", "showOnHome", "sizeLabel", "sortOrder", "updatedAt" FROM "Special";
DROP TABLE "Special";
ALTER TABLE "new_Special" RENAME TO "Special";
CREATE TABLE "new_SpecialItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "specialId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "sizeLabel" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "extras" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SpecialItem_specialId_fkey" FOREIGN KEY ("specialId") REFERENCES "Special" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpecialItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SpecialItem" ("extras", "id", "itemId", "quantity", "sizeLabel", "specialId") SELECT "extras", "id", "itemId", "quantity", "sizeLabel", "specialId" FROM "SpecialItem";
DROP TABLE "SpecialItem";
ALTER TABLE "new_SpecialItem" RENAME TO "SpecialItem";
CREATE UNIQUE INDEX "SpecialItem_specialId_itemId_sizeLabel_key" ON "SpecialItem"("specialId", "itemId", "sizeLabel");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
