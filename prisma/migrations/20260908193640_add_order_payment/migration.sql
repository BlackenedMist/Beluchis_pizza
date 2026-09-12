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
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("createdAt", "customerId", "deliveryAddress", "deliveryLat", "deliveryLng", "discountAmount", "discountCode", "discountLabel", "grandTotal", "id", "notes", "status", "total") SELECT "createdAt", "customerId", "deliveryAddress", "deliveryLat", "deliveryLng", "discountAmount", "discountCode", "discountLabel", "grandTotal", "id", "notes", "status", "total" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
