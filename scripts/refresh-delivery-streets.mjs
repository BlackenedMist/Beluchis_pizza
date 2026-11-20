import { refreshDeliveryStreets, deliveryPrisma } from "../server/deliveryStreets.mjs";

try {
  const result = await refreshDeliveryStreets();
  console.log(`Street refresh OK in ${result.durationMs}ms — ${result.total} streets from ${result.ways} OSM ways`);
  console.log("Per zone:", JSON.stringify(result.counts));
} catch (err) {
  console.error("Street refresh failed:", err.message);
  process.exitCode = 1;
} finally {
  await deliveryPrisma.$disconnect();
}
