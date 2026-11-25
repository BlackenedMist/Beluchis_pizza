// One-off, idempotent migration: folds the legacy Base / PastaType catalogue
// into the generic OptionSet model. Run from the repo root:
//   node --env-file-if-exists=.env scripts/migrate-option-sets.mjs
//
// Legacy tables are deliberately left in place for historical orders.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

async function migrateLegacy(kind, label, receiptName) {
  const rows = await prisma[kind].findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { prices: true },
  });
  const sizeLabels = [...new Set(rows.flatMap((r) => r.prices.map((p) => p.sizeLabel || '')).filter(Boolean))];
  const specs = sizeLabels.length ? sizeLabels : [''];
  let createdSets = 0;
  let createdValues = 0;
  let createdLinks = 0;

  for (const sizeLabel of specs) {
    const eligible = rows.filter((r) => !sizeLabel || r.prices.some((p) => (p.sizeLabel || '') === sizeLabel));
    if (!eligible.length) continue;
    const size = sizeLabel || null;
    const name = label;
    const slug = slugify(`${label}-${sizeLabel || 'all'}`);
    let set = await prisma.optionSet.findUnique({ where: { slug } });
    if (!set) {
      set = await prisma.optionSet.create({
        data: {
          name,
          slug,
          receiptName,
          sizeLabel: size,
          sortOrder: 0,
          isActive: true,
        },
      });
      createdSets++;
    }

    for (const row of eligible) {
      const priceRow = row.prices.find((p) => (p.sizeLabel || '') === sizeLabel);
      const existing = await prisma.optionValue.findFirst({
        where: { legacyType: kind, legacyId: row.id, legacySizeLabel: sizeLabel },
      });
      const data = {
        name: row.name,
        price: priceRow ? Number(priceRow.price) || 0 : 0,
        sortOrder: row.sortOrder || 0,
        isActive: row.isActive !== false,
      };
      if (existing) {
        await prisma.optionValue.update({ where: { id: existing.id }, data });
      } else {
        await prisma.optionValue.create({
          data: {
            optionSetId: set.id,
            legacyType: kind,
            legacyId: row.id,
            legacySizeLabel: sizeLabel,
            ...data,
          },
        });
        createdValues++;
      }

      // Link the item only when it sells this size (or has no explicit sizes,
      // in which case every set of this kind applies).
      const linkModel = kind === 'pastaType' ? prisma.itemPastaType : prisma.itemBase;
      const links = await linkModel.findMany({ where: { [`${kind}Id`]: row.id }, select: { itemId: true } });
      for (const { itemId } of links) {
        const sizes = await prisma.itemSize.findMany({ where: { itemId }, select: { sizeLabel: true } });
        if (sizeLabel && sizes.length && !sizes.some((s) => s.sizeLabel === sizeLabel)) continue;
        const exists = await prisma.itemOptionSet.findUnique({
          where: { itemId_optionSetId: { itemId, optionSetId: set.id } },
        });
        if (!exists) {
          await prisma.itemOptionSet.create({ data: { itemId, optionSetId: set.id } });
          createdLinks++;
        }
      }
    }
  }
  return { createdSets, createdValues, createdLinks, sizeLabels: specs.filter(Boolean) };
}

try {
  const pasta = await migrateLegacy('pastaType', 'Pasta type', 'Pasta');
  const bases = await migrateLegacy('base', 'Base', 'Base');
  console.log(JSON.stringify({ pasta, bases }, null, 2));
} finally {
  await prisma.$disconnect();
}
