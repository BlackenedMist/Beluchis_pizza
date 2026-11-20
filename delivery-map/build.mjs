// Build the assets used by the main app. Run from the repo root:
//   node delivery-map/build.mjs   (or npm run build:delivery-map)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assets = path.join(root, 'public', 'assets');

fs.mkdirSync(assets, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/integration.js')],
  outfile: path.join(assets, 'beluchis-delivery.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});

const geocoderDist = path.join(root, 'node_modules', 'leaflet-control-geocoder', 'dist');
for (const file of ['Control.Geocoder.js', 'Control.Geocoder.css']) {
  fs.copyFileSync(path.join(geocoderDist, file), path.join(assets, file));
}
console.log('Wrote public/assets/beluchis-delivery.js + geocoder assets');
