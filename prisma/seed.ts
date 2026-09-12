import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
const CATALOG = path.resolve(import.meta.dirname, "..", "catalog");
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

async function main() {
  const categories = JSON.parse(fs.readFileSync(path.join(CATALOG, "categories.json"), "utf8"));
  const items = JSON.parse(fs.readFileSync(path.join(CATALOG, "items.json"), "utf8"));
  const toppings = JSON.parse(fs.readFileSync(path.join(CATALOG, "toppings.json"), "utf8"));
  const bases = JSON.parse(fs.readFileSync(path.join(CATALOG, "bases.json"), "utf8"));
  const links = JSON.parse(fs.readFileSync(path.join(CATALOG, "links.json"), "utf8"));

  const sw = Date.now();

  await prisma.$transaction(async (tx) => {
    // Wipe child rows so re-runs are fully idempotent.
    await tx.specialItem.deleteMany();
    await tx.special.deleteMany();
    await tx.orderItem.deleteMany();
    await tx.order.deleteMany();
    await tx.customer.deleteMany();
    await tx.itemTopping.deleteMany();
    await tx.itemBase.deleteMany();
    await tx.itemSize.deleteMany();
    await tx.toppingPrice.deleteMany();
    await tx.basePrice.deleteMany();
    await tx.item.deleteMany();
    await tx.topping.deleteMany();
    await tx.base.deleteMany();
    await tx.category.deleteMany();

    for (const c of categories) {
      await tx.category.create({ data: c });
    }
    const categoryBySlug = new Map((await tx.category.findMany()).map((c) => [c.slug, c.id]));

    for (const item of items) {
      const { sizes, category, ...data } = item;
      const saved = await tx.item.create({
        data: { ...data, categoryId: categoryBySlug.get(category) ?? categoryBySlug.get(slugify(category)) ?? null },
      });
      if (sizes.length) {
        await tx.itemSize.createMany({
          data: sizes.map((s) => ({ itemId: saved.id, sizeLabel: s.sizeLabel, price: s.price })),
        });
      }
    }

    for (const t of toppings) {
      const { prices, ...data } = t;
      const saved = await tx.topping.create({ data });
      if (prices.length) {
        await tx.toppingPrice.createMany({
          data: prices.map((p) => ({ toppingId: saved.id, sizeLabel: p.sizeLabel, price: p.price })),
        });
      }
    }

    for (const b of bases) {
      const { prices, ...data } = b;
      const saved = await tx.base.create({ data });
      if (prices.length) {
        await tx.basePrice.createMany({
          data: prices.map((p) => ({ baseId: saved.id, sizeLabel: p.sizeLabel, price: p.price })),
        });
      }
    }

    const itemBySlug = new Map((await tx.item.findMany()).map((i) => [i.slug, i.id]));
    const toppingBySlug = new Map((await tx.topping.findMany()).map((t) => [t.slug, t.id]));
    const baseBySlug = new Map((await tx.base.findMany()).map((b) => [b.slug, b.id]));

    const itemToppingRows = [];
    for (const link of links.itemTopping) {
      const itemId = itemBySlug.get(link.itemSlug);
      if (!itemId) continue;
      for (const tSlug of link.toppingSlugs) {
        const toppingId = toppingBySlug.get(tSlug);
        if (toppingId) itemToppingRows.push({ itemId, toppingId, sortOrder: 0 });
      }
    }
    if (itemToppingRows.length) {
      await tx.itemTopping.createMany({ data: itemToppingRows });
    }

    const itemBaseRows = [];
    for (const link of links.itemBase) {
      const itemId = itemBySlug.get(link.itemSlug);
      if (!itemId) continue;
      for (const bSlug of link.baseSlugs) {
        const baseId = baseBySlug.get(bSlug);
        if (baseId) itemBaseRows.push({ itemId, baseId });
      }
    }
    if (itemBaseRows.length) {
      await tx.itemBase.createMany({ data: itemBaseRows });
    }

    // -------------------------------------------------------- Demo customers
    const passwordHash = await bcrypt.hash("beluchis123", 10);
    const demoCustomers = [
      { firstName: "Nomsa", lastName: "Dlamini", email: "nomsa@example.com", cellphone: null, username: "nomsa", lat: -26.2041, lng: 28.0473, addressLabel: "Sandton" },
      { firstName: "Thabo", lastName: "Mokoena", email: null, cellphone: "+27 82 555 0123", username: "thabo", lat: -26.1076, lng: 28.0567, addressLabel: "Rosebank" },
      { firstName: "Priya", lastName: "Naidoo", email: "priya@example.com", cellphone: "+27 71 555 0456", username: "priya", lat: -26.1292, lng: 28.2181, addressLabel: "Benoni" },
    ];
    const createdCustomers = [];
    for (const c of demoCustomers) {
      createdCustomers.push(await tx.customer.create({ data: { ...c, passwordHash } }));
    }

    const sizedItems = await tx.item.findMany({ where: { sizes: { some: {} } }, include: { sizes: true }, take: 4 });
    const toOrderItems = (items) =>
      items.map((item) => {
        const size = item.sizes[0];
        return { itemId: item.id, itemName: item.name, sizeLabel: size.sizeLabel, unitPrice: size.price, quantity: 1, extras: null, total: size.price };
      });
    const mkOrder = async (customer, items, opts = {}) => {
      const rows = toOrderItems(items);
      await tx.order.create({
        data: {
          customerId: customer.id,
          status: opts.status ?? "delivered",
          total: rows.reduce((sum, r) => sum + r.total, 0),
          deliveryLat: opts.deliveryLat ?? customer.lat,
          deliveryLng: opts.deliveryLng ?? customer.lng,
          deliveryAddress: opts.deliveryAddress ?? customer.addressLabel,
          notes: opts.notes ?? null,
          items: { create: rows },
        },
      });
    };

    const [nomsa, thabo, priya] = createdCustomers;
    if (sizedItems.length >= 3) {
      await mkOrder(nomsa, [sizedItems[0], sizedItems[1]], { status: "placed" });
      await mkOrder(nomsa, [sizedItems[2]], { notes: "Extra spicy" });
      await mkOrder(thabo, [sizedItems[1], sizedItems[2]], { status: "delivered" });
      await mkOrder(priya, [sizedItems[0], sizedItems[3]], { status: "preparing", notes: "Call on arrival" });
    }

    // -------------------------------------------------------- Demo specials
    if (sizedItems.length >= 2) {
      const specialRows = [
        { name: "Family Combo", description: "Two mains plus a side at a brilliant price", price: 169, isActive: true, sortOrder: 1, items: [[sizedItems[0], 2], [sizedItems[1], 1]] },
        { name: "Date Night Duo", description: "One main, one drink, one dessert pick", price: 99, isActive: true, sortOrder: 2, items: [[sizedItems[2], 1], [sizedItems[3], 1]] },
      ];
      for (const { items, ...data } of specialRows) {
        await tx.special.create({
          data: {
            ...data,
            items: {
              create: items.map(([item, quantity]) => ({ itemId: item.id, quantity })),
            },
          },
        });
      }
    }

    // ------------------------------------------------- Store/settings defaults
    // Delivery radius policy + shop centre (Worcester CBD default). Upsert so a
    // reseed never clobbers radius choices the owner made in the admin panel.
    const defaultSettings = [
      { key: "shop.lat", value: "-33.646" },
      { key: "shop.lng", value: "19.448" },
      { key: "delivery.freeRadiusKm", value: "3" },
      { key: "delivery.maxRadiusKm", value: "10" },
      { key: "delivery.feeAmount", value: "30" },
      { key: "delivery.enabled", value: "true" },
    ];
    for (const { key, value } of defaultSettings) {
      await tx.setting.upsert({ where: { key }, update: {}, create: { key, value } });
    }
  });

  const [c, i, t, b, it, ib, cu, o, oi, sp, se] = await Promise.all([
    prisma.category.count(),
    prisma.item.count(),
    prisma.topping.count(),
    prisma.base.count(),
    prisma.itemTopping.count(),
    prisma.itemBase.count(),
    prisma.customer.count(),
    prisma.order.count(),
    prisma.orderItem.count(),
    prisma.special.count(),
    prisma.setting.count(),
  ]);
  console.log(`Seeded in ${Date.now() - sw}ms: ${c} categories, ${i} items, ${t} toppings, ${b} bases, ${it} item→topping links, ${ib} item→base links, ${cu} customers, ${o} orders, ${oi} order items, ${sp} specials, ${se} settings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());