// Minimal parser for WordPress mysqldump INSERT statements.
//
// The backup files are plain SQL dumps with one INSERT per line, e.g.:
//   INSERT INTO `wpsi_28_wc_customer_lookup` VALUES('1958', NULL, '', 'Belinda', 'Truter', 'belinda@x.co.za', ...);
//
// This module extracts the tuple rows without needing a MySQL server. It only
// understands the subset of SQL the dumps actually use (no expressions, no
// hex constants, optional column list ignored).

import fs from "node:fs";
import readline from "node:readline";
import { createReadStream } from "node:fs";

// Strips the surrounding quotes from a raw SQL field and unescapes backslash
// escapes. Mirrors MySQL string literal rules closely enough for these dumps.
function unescapeField(raw) {
  if (raw === "NULL") return null;
  const s = String(raw);
  if (!s.startsWith("'")) return s; // numeric/date literal, keep as-is
  let body = s.slice(1, -1);
  body = body.replace(/\\(.)/g, (_, ch) => ch);
  return body;
}

// Splits the VALUES(...) tuple of one INSERT line into its fields.
// Handles single-quoted strings that contain commas, parens and escaped
// quotes (\' \\ \" \n). Returns null when the line is not an INSERT tuple.
export function parseInsertLine(line) {
  const m = line.match(/^INSERT INTO `([^`]+)`\s+VALUES\s*\(/i);
  if (!m) return null;
  const table = m[1];
  let i = m[0].length;
  const fields = [];
  let cur = "";
  let inStr = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === "\\") {
        cur += c + (line[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === "'") {
        inStr = false;
        cur += "'";
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === ",") {
      fields.push(unescapeField(cur.trim()));
      cur = "";
      continue;
    }
    if (c === ")") {
      fields.push(unescapeField(cur.trim()));
      break;
    }
    cur += c;
  }
  return { table, fields };
}

// Reads a dump file line by line and invokes `onRow(table, fields)` for every
// INSERT row found. Runs in a single pass so the 51 MB postmeta dump can be
// scanned without loading it all into memory.
export async function scanDump(file, onRow, options = {}) {
  const skip = new Set(options.onlyTables || []);
  const keep = new Set(options.tables || null);
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let lines = 0;
  let rows = 0;
  for await (const line of rl) {
    lines++;
    if (!line.startsWith("INSERT INTO")) continue;
    const parsed = parseInsertLine(line);
    if (!parsed) continue;
    if (skip.has(parsed.table)) continue;
    if (keep.size && !keep.has(parsed.table)) continue;
    rows++;
    onRow(parsed.table, parsed.fields);
  }
  return { lines, rows };
}

// Convenience: load every row of one small dump file into an array.
export function loadTableRows(file) {
  const out = [];
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const parsed = parseInsertLine(line);
    if (parsed) out.push(parsed.fields);
  }
  return out;
}