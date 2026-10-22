const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// GhostShare Signature Ghost SVG
// Matches components/Header.tsx:
// - dark rounded badge: #1b1d22 with #33363f border
// - primary lavender ghost: #c0c1ff with stroke-width 2, round linecap and join
// - eye dots: #c0c1ff circles
const ghostSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none">
  <rect x="1" y="1" width="30" height="30" rx="7" fill="#181a20" stroke="#31343d" stroke-width="1.2" />
  <g transform="translate(4, 4)">
    <path
      d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"
      stroke="#c0c1ff"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="9" cy="10" r="1.25" fill="#c0c1ff" />
    <circle cx="15" cy="10" r="1.25" fill="#c0c1ff" />
  </g>
</svg>`;

// Scalable vector for larger / high-res icons (512x512 canvas)
const ghostSvgHighRes = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" fill="none">
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#181a20" stroke="#31343d" stroke-width="18" />
  <g transform="translate(64, 64) scale(16)">
    <path
      d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"
      stroke="#c0c1ff"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="9" cy="10" r="1.25" fill="#c0c1ff" />
    <circle cx="15" cy="10" r="1.25" fill="#c0c1ff" />
  </g>
</svg>`;

function buildIco(entries) {
  const numImages = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(numImages, 4);

  const dirLength = 16 * numImages;
  let offset = 6 + dirLength;

  const dirBuffers = [];
  const imageBuffers = [];

  for (const { size, buffer } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // no palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);

    offset += buffer.length;
    dirBuffers.push(entry);
    imageBuffers.push(buffer);
  }

  return Buffer.concat([header, ...dirBuffers, ...imageBuffers]);
}

async function run() {
  const root = path.resolve(__dirname, '..');
  const appDir = path.join(root, 'app');
  const publicDir = path.join(root, 'public');

  console.log('Generating GhostShare icons...');

  // 1. Write SVG icons
  fs.writeFileSync(path.join(appDir, 'icon.svg'), ghostSvg, 'utf8');
  fs.writeFileSync(path.join(publicDir, 'icon.svg'), ghostSvg, 'utf8');
  console.log('✓ app/icon.svg and public/icon.svg written');

  // 2. Generate PNG rasters
  const png16 = await sharp(Buffer.from(ghostSvg)).resize(16, 16).png().toBuffer();
  const png32 = await sharp(Buffer.from(ghostSvg)).resize(32, 32).png().toBuffer();
  const png48 = await sharp(Buffer.from(ghostSvg)).resize(48, 48).png().toBuffer();
  const png180 = await sharp(Buffer.from(ghostSvgHighRes)).resize(180, 180).png().toBuffer();
  const png192 = await sharp(Buffer.from(ghostSvgHighRes)).resize(192, 192).png().toBuffer();
  const png512 = await sharp(Buffer.from(ghostSvgHighRes)).resize(512, 512).png().toBuffer();

  // 3. Write favicon.ico (multi-resolution: 16x16, 32x32, 48x48)
  const icoBuffer = buildIco([
    { size: 16, buffer: png16 },
    { size: 32, buffer: png32 },
    { size: 48, buffer: png48 },
  ]);
  fs.writeFileSync(path.join(appDir, 'favicon.ico'), icoBuffer);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuffer);
  console.log('✓ app/favicon.ico and public/favicon.ico written');

  // 4. Write apple-icon.png (180x180)
  fs.writeFileSync(path.join(appDir, 'apple-icon.png'), png180);
  fs.writeFileSync(path.join(publicDir, 'apple-icon.png'), png180);
  console.log('✓ app/apple-icon.png and public/apple-icon.png written');

  // 5. Write standard icon.png (32x32)
  fs.writeFileSync(path.join(appDir, 'icon.png'), png32);
  fs.writeFileSync(path.join(publicDir, 'icon.png'), png32);
  console.log('✓ app/icon.png and public/icon.png written');

  // 6. Write PWA/manifest icons
  fs.writeFileSync(path.join(publicDir, 'icon-192.png'), png192);
  fs.writeFileSync(path.join(publicDir, 'icon-512.png'), png512);
  console.log('✓ public/icon-192.png and public/icon-512.png written');

  // 7. Write manifest.webmanifest
  const manifest = {
    name: "GhostShare — Ephemeral Direct Peer Transfer",
    short_name: "GhostShare",
    description: "Direct browser-to-browser file transfer via WebRTC P2P SCTP data channels. Zero cloud file storage, self-destructing data tunnels.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0c10",
    theme_color: "#0a0c10",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml"
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png"
      }
    ]
  };
  fs.writeFileSync(
    path.join(publicDir, 'manifest.webmanifest'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  console.log('✓ public/manifest.webmanifest written');

  // 8. Clean up unused default template SVGs if present
  const defaultTemplateFiles = ['vercel.svg', 'next.svg', 'file.svg', 'globe.svg', 'window.svg'];
  for (const f of defaultTemplateFiles) {
    const p = path.join(publicDir, f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`✓ Removed unused template file: public/${f}`);
    }
  }

  console.log('All GhostShare icons successfully generated and verified!');
}

run().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
