-- Pasta types, their per-size price adjustments, and the items that offer them.
CREATE TABLE "PastaType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "PastaType_slug_key" ON "PastaType"("slug");

CREATE TABLE "PastaTypePrice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pastaTypeId" INTEGER NOT NULL,
    "sizeLabel" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    CONSTRAINT "PastaTypePrice_pastaTypeId_fkey" FOREIGN KEY ("pastaTypeId") REFERENCES "PastaType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PastaTypePrice_pastaTypeId_sizeLabel_key" ON "PastaTypePrice"("pastaTypeId", "sizeLabel");

CREATE TABLE "ItemPastaType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER NOT NULL,
    "pastaTypeId" INTEGER NOT NULL,
    CONSTRAINT "ItemPastaType_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemPastaType_pastaTypeId_fkey" FOREIGN KEY ("pastaTypeId") REFERENCES "PastaType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ItemPastaType_itemId_pastaTypeId_key" ON "ItemPastaType"("itemId", "pastaTypeId");
