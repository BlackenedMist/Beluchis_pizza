-- Generic, reusable option lists (replaces the hard-coded Bases/PastaTypes UI).
-- Legacy tables are kept deliberately for historical orders and old carts.

-- CreateTable
CREATE TABLE "OptionSet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "receiptName" TEXT,
    "sizeLabel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "optionSetId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "legacyType" TEXT,
    "legacyId" INTEGER,
    "legacySizeLabel" TEXT,
    CONSTRAINT "OptionValue_optionSetId_fkey" FOREIGN KEY ("optionSetId") REFERENCES "OptionSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemOptionSet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER NOT NULL,
    "optionSetId" INTEGER NOT NULL,
    CONSTRAINT "ItemOptionSet_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemOptionSet_optionSetId_fkey" FOREIGN KEY ("optionSetId") REFERENCES "OptionSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OptionSet_slug_key" ON "OptionSet"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OptionSet_name_sizeLabel_key" ON "OptionSet"("name", "sizeLabel");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_optionSetId_name_key" ON "OptionValue"("optionSetId", "name");

-- CreateIndex
CREATE INDEX "OptionValue_legacyType_legacyId_idx" ON "OptionValue"("legacyType", "legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemOptionSet_itemId_optionSetId_key" ON "ItemOptionSet"("itemId", "optionSetId");
