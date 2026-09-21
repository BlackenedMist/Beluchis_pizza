// Phone number normalisation shared by the server (login/checkout/claim) and
// the WP customer import script. Both sides must agree on one canonical form:
//   +27831234567   (E.164, SA country code, no leading zero on national part)
//
// Returns null when the input can't be confidently mapped onto a South
// African number — callers then fall back to the raw trimmed string so the
// existing exact-match behaviour is preserved for odd entries.
export function normalizePhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;

  // 27XXXXXXXXX, with or without a leading + (11 digits, 27 prefix).
  if (digits.length === 11 && digits.startsWith("27")) return `+${digits}`;

  // 0XXXXXXXXX (10 digits, leading local zero) — canonical national form.
  if (digits.length === 10 && digits.startsWith("0")) return `+27${digits.slice(1)}`;

  return null;
}

// Canonical form for storage/lookup, or the trimmed raw string unchanged.
// Mirrors what the server does at every phone entry point so the import
// script and the app stay in lockstep.
export function canonicalPhone(raw) {
  return normalizePhone(raw) ?? (raw == null ? null : String(raw).trim());
}