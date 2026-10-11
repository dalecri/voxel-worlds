// Assembles www/ for the Android app: the web app plus local copies of three.js,
// the fonts and Capacitor's runtime, so the APK works fully offline.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const nm = p => join(root, 'node_modules', p);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor', 'fonts'), { recursive: true });
mkdirSync(join(out, 'assets'), { recursive: true });

for (const f of ['sim.js', 'render.js', 'main.js', 'storage.js']) copyFileSync(join(root, f), join(out, f));
copyFileSync(join(root, 'assets', 'icon.png'), join(out, 'assets', 'icon.png'));
copyFileSync(nm('three/build/three.min.js'), join(out, 'vendor', 'three.min.js'));
copyFileSync(nm('@capacitor/core/dist/capacitor.js'), join(out, 'vendor', 'capacitor.js'));

// fonts: latin subsets of the weights the app uses
let css = '';
const fonts = { fredoka: [400, 500, 600], nunito: [400, 600, 700, 800] };
for (const [family, weights] of Object.entries(fonts)) {
  for (const w of weights) {
    const src = readFileSync(nm(`@fontsource/${family}/latin-${w}.css`), 'utf8');
    for (const [, file] of src.matchAll(/url\(\.\/files\/([^)]+)\)/g)) {
      copyFileSync(nm(`@fontsource/${family}/files/${file}`), join(out, 'vendor', 'fonts', file));
    }
    css += src.replace(/url\(\.\/files\//g, 'url(fonts/') + '\n';
  }
}
writeFileSync(join(out, 'vendor', 'fonts.css'), css);

// index.html: swap CDN links for the bundled copies
let html = readFileSync(join(root, 'index.html'), 'utf8');
const swap = (from, to) => {
  if (!from.test(html)) throw new Error('build-www: pattern not found ' + from);
  html = html.replace(from, to);
};
swap(/<link rel="preconnect"[^>]*>\s*<link rel="preconnect"[^>]*>\s*<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="vendor/fonts.css">');
swap(/<script src="https:\/\/unpkg\.com\/three@0\.160\.0\/build\/three\.min\.js"><\/script>/, '<script src="vendor/three.min.js"></script>');
swap(/<script src="storage\.js"><\/script>/, '<script src="vendor/capacitor.js"></script>\n<script src="storage.js"></script>');
writeFileSync(join(out, 'index.html'), html);

console.log('www/ ready');
