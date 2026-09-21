import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(ROOT, process.env.STORAGE_DIR || 'data');
export const PRINTS_DIR = path.join(DATA_DIR, 'prints');

mkdirSync(PRINTS_DIR, { recursive: true });

const cache = new Map();

export function seed(file, defaults) {
  const absolute = path.join(DATA_DIR, `${file}.json`);
  if (!cache.has(file)) {
    let value;
    try {
      value = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch {
      value = structuredClone(defaults);
      writeAtomic(absolute, value);
    }
    cache.set(file, value);
  }
  return cache.get(file);
}

export function flush(file) {
  const value = cache.get(file);
  if (value) writeAtomic(path.join(DATA_DIR, `${file}.json`), value);
}

export function writeAtomic(absolute, value) {
  const tmp = `${absolute}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, absolute);
}