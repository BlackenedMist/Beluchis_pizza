-- CreateTable
CREATE TABLE "Favorite" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customerId" INTEGER NOT NULL,
    "itemId" INTEGER,
    "specialId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Favorite_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Favorite_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Favorite_specialId_fkey" FOREIGN KEY ("specialId") REFERENCES "Special" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Item" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'menuitem',
    "categoryId" INTEGER,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "showOnHome" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("categoryId", "description", "id", "imageUrl", "isActive", "isFeatured", "itemType", "name", "slug", "sortOrder") SELECT "categoryId", "description", "id", "imageUrl", "isActive", "isFeatured", "itemType", "name", "slug", "sortOrder" FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_slug_key" ON "Item"("slug");
CREATE TABLE "new_Special" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'flat',
    "categoryId" INTEGER,
    "sizeLabel" TEXT,
    "count" INTEGER NOT NULL DEFAULT 2,
    "imageUrl" TEXT,
    "showOnHome" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Special_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Special" ("createdAt", "description", "id", "isActive", "name", "price", "sortOrder", "updatedAt") SELECT "createdAt", "description", "id", "isActive", "name", "price", "sortOrder", "updatedAt" FROM "Special";
DROP TABLE "Special";
ALTER TABLE "new_Special" RENAME TO "Special";
CREATE TABLE "new_Topping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isInSeason" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_Topping" ("id", "isActive", "name", "slug", "sortOrder", "tier") SELECT "id", "isActive", "name", "slug", "sortOrder", "tier" FROM "Topping";
DROP TABLE "Topping";
ALTER TABLE "new_Topping" RENAME TO "Topping";
CREATE UNIQUE INDEX "Topping_slug_key" ON "Topping"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_customerId_itemId_key" ON "Favorite"("customerId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_customerId_specialId_key" ON "Favorite"("customerId", "specialId");
