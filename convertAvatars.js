const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const inputDir = path.resolve(__dirname, "public/images/avatars");

async function convertDirectory(currentDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await convertDirectory(fullPath);
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== ".png") continue;

    const outputPath = path.join(currentDir, path.basename(entry.name, path.extname(entry.name)) + ".webp");
    try {
      await sharp(fullPath)
        .resize(256, 256, {
          fit: "contain",
          position: "centre",
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .webp({ lossless: true, quality: 100, alphaQuality: 100 })
        .toFile(outputPath);
      console.log("✔", path.relative(inputDir, outputPath));
    } catch (err) {
      console.error("✖", fullPath, err);
    }
  }
}

(async () => {
  if (!fs.existsSync(inputDir)) {
    console.error("Directory not found:", inputDir);
    process.exitCode = 1;
    return;
  }
  await convertDirectory(inputDir);
  console.log("Done converting avatar PNGs to 256x256 WebP.");
})().catch(err => { console.error(err); process.exitCode = 1; });
