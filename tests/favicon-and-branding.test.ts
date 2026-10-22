import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

test("Favicon: app/favicon.ico and public/favicon.ico exist and match valid ICO format", () => {
  const appIcoPath = path.join(ROOT, "app", "favicon.ico");
  const publicIcoPath = path.join(ROOT, "public", "favicon.ico");

  assert.ok(fs.existsSync(appIcoPath), "app/favicon.ico must exist");
  assert.ok(fs.existsSync(publicIcoPath), "public/favicon.ico must exist");

  const appIco = fs.readFileSync(appIcoPath);
  const publicIco = fs.readFileSync(publicIcoPath);

  assert.ok(appIco.length > 500, "app/favicon.ico must be non-empty");
  assert.ok(publicIco.length > 500, "public/favicon.ico must be non-empty");

  // Validate ICO magic header: 0x0000 (reserved) + 0x0001 (icon type)
  assert.equal(appIco.readUInt16LE(0), 0, "ICO reserved field must be 0");
  assert.equal(appIco.readUInt16LE(2), 1, "ICO type field must be 1 (icon)");
  assert.equal(publicIco.readUInt16LE(0), 0, "Public ICO reserved field must be 0");
  assert.equal(publicIco.readUInt16LE(2), 1, "Public ICO type field must be 1 (icon)");

  // Must contain multiple icon resolutions (e.g. 16, 32, 48)
  const numImages = appIco.readUInt16LE(4);
  assert.ok(numImages >= 2, `ICO must contain multiple sizes for crisp rendering (found ${numImages})`);
});

test("Vector Icon: app/icon.svg and public/icon.svg contain the signature GhostShare ghost", () => {
  const appSvgPath = path.join(ROOT, "app", "icon.svg");
  const publicSvgPath = path.join(ROOT, "public", "icon.svg");

  assert.ok(fs.existsSync(appSvgPath), "app/icon.svg must exist");
  assert.ok(fs.existsSync(publicSvgPath), "public/icon.svg must exist");

  const appSvg = fs.readFileSync(appSvgPath, "utf8");
  const publicSvg = fs.readFileSync(publicSvgPath, "utf8");

  // Verify signature ghost path from Header.tsx is present
  const ghostBodyPath = "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z";
  assert.ok(appSvg.includes(ghostBodyPath), "app/icon.svg must contain GhostShare signature ghost path");
  assert.ok(publicSvg.includes(ghostBodyPath), "public/icon.svg must contain GhostShare signature ghost path");

  // Verify eyes are present
  assert.ok(appSvg.includes('cx="9" cy="10"'), "app/icon.svg must contain left eye");
  assert.ok(appSvg.includes('cx="15" cy="10"'), "app/icon.svg must contain right eye");

  // Ensure default Vercel triangle is NOT present
  assert.ok(!appSvg.includes("577"), "app/icon.svg must not contain Vercel triangle coordinates");
  assert.ok(!publicSvg.includes("577"), "public/icon.svg must not contain Vercel triangle coordinates");
});

test("Apple & PWA Icons: PNG assets exist with valid PNG magic headers", () => {
  const pngAssets = [
    path.join(ROOT, "app", "apple-icon.png"),
    path.join(ROOT, "public", "apple-icon.png"),
    path.join(ROOT, "app", "icon.png"),
    path.join(ROOT, "public", "icon.png"),
    path.join(ROOT, "public", "icon-192.png"),
    path.join(ROOT, "public", "icon-512.png"),
  ];

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  for (const assetPath of pngAssets) {
    assert.ok(fs.existsSync(assetPath), `${path.basename(assetPath)} must exist`);
    const buf = fs.readFileSync(assetPath);
    assert.ok(buf.length > 100, `${path.basename(assetPath)} must be non-empty`);
    assert.deepEqual(
      buf.subarray(0, 8),
      PNG_MAGIC,
      `${path.basename(assetPath)} must have valid PNG magic signature`,
    );
  }
});

test("Cleanup: default Vercel template SVGs are completely eliminated", () => {
  const vercelSvg = path.join(ROOT, "public", "vercel.svg");
  const nextSvg = path.join(ROOT, "public", "next.svg");

  assert.ok(!fs.existsSync(vercelSvg), "public/vercel.svg must be eliminated");
  assert.ok(!fs.existsSync(nextSvg), "public/next.svg must be eliminated");
});

test("Metadata: Root layout metadata correctly declares GhostShare ghost icons and manifest", () => {
  const layoutPath = path.join(ROOT, "app", "layout.tsx");
  assert.ok(fs.existsSync(layoutPath), "app/layout.tsx must exist");
  const layoutSource = fs.readFileSync(layoutPath, "utf8");

  assert.ok(layoutSource.includes('icons: {'), "Metadata must declare icons configuration");
  assert.ok(layoutSource.includes('url: "/icon.svg"'), "Metadata must reference /icon.svg");
  assert.ok(layoutSource.includes('url: "/favicon.ico"'), "Metadata must reference /favicon.ico");
  assert.ok(layoutSource.includes('url: "/apple-icon.png"'), "Metadata must reference /apple-icon.png");
  assert.ok(layoutSource.includes('manifest: "/manifest.webmanifest"'), "Metadata must reference /manifest.webmanifest");
});

test("Web App Manifest: public/manifest.webmanifest is valid and links GhostShare icons", () => {
  const manifestPath = path.join(ROOT, "public", "manifest.webmanifest");
  assert.ok(fs.existsSync(manifestPath), "public/manifest.webmanifest must exist");

  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  assert.equal(manifest.name, "GhostShare — Ephemeral Direct Peer Transfer");
  assert.equal(manifest.short_name, "GhostShare");
  assert.ok(Array.isArray(manifest.icons));
  assert.ok(manifest.icons.some((i: { src: string }) => i.src === "/icon.svg"));
  assert.ok(manifest.icons.some((i: { src: string }) => i.src === "/icon-192.png"));
  assert.ok(manifest.icons.some((i: { src: string }) => i.src === "/icon-512.png"));
});
