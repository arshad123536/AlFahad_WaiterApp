// One-off icon generator, run by hand (`node scripts/gen-icons.js`) after
// npm install --save-dev sharp -- not part of the normal build, since app
// icons change rarely. Rasterizes the same الفهد 3-dot logo used as the
// dashboard's own favicon (see public/index.html's <link rel="icon">) into
// every launcher-icon size Android needs.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// Full logo: dark circle + 3 ember/gold dots -- used for the legacy
// (pre-Android-8) launcher icons, which have no separate background layer.
const FULL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#171009"/><circle cx="11" cy="21" r="3" fill="#f0a125"/><circle cx="17" cy="15" r="3.6" fill="#e8531f"/><circle cx="23" cy="9" r="2.4" fill="#f0a125"/></svg>`;

// Dots only, transparent background, re-centered and scaled to sit inside
// the adaptive icon's ~66/108 safe zone -- the background color layer
// (ic_launcher_background.xml) provides the dark circle separately, so
// baking it into this layer too would double up and also risk getting
// clipped differently than the background across launchers' mask shapes.
const FOREGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">
  <g transform="translate(54 54) scale(1.55) translate(-16 -16)">
    <circle cx="11" cy="21" r="3" fill="#f0a125"/>
    <circle cx="17" cy="15" r="3.6" fill="#e8531f"/>
    <circle cx="23" cy="9" r="2.4" fill="#f0a125"/>
  </g>
</svg>`;

const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

async function run() {
  for (const [density, size] of Object.entries(LEGACY_SIZES)) {
    const dir = path.join(RES, `mipmap-${density}`);
    const buf = await sharp(Buffer.from(FULL_SVG)).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), buf);
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), buf); // same art -- it's already a circle
  }
  for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
    const dir = path.join(RES, `mipmap-${density}`);
    const buf = await sharp(Buffer.from(FOREGROUND_SVG)).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), buf);
  }
  // Adaptive icon's background layer -- matches the logo's own circle fill.
  fs.writeFileSync(
    path.join(RES, 'values', 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#171009</color>\n</resources>\n'
  );
  console.log('Icons written.');
}

run().catch((err) => { console.error(err); process.exit(1); });
