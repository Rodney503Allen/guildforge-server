const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const inputDir = "./public/icons/spellspng";
const outputDir = "./public/icons/spells_webp";

async function convertDirectory(currentDir) {
  const entries = fs.readdirSync(currentDir, {
    withFileTypes: true
  });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await convertDirectory(fullPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();

    if (![".png", ".jpg", ".jpeg"].includes(ext)) {
      continue;
    }

    const relativeDir = path.relative(inputDir, currentDir);

    const destinationDir = path.join(
      outputDir,
      relativeDir
    );

    fs.mkdirSync(destinationDir, {
      recursive: true
    });

    const outputPath = path.join(
      destinationDir,
      path.basename(entry.name, ext) + ".webp"
    );

    try {
      await sharp(fullPath)
        .resize(128, 128, {
          fit: "inside",
          withoutEnlargement: true
        })
        .webp({
          quality: 85,
          alphaQuality: 100
        })
        .toFile(outputPath);

      console.log("✔", path.relative(inputDir, fullPath));
    } catch (err) {
      console.error("✖", fullPath, err);
    }
  }
}

(async () => {
  await convertDirectory(inputDir);
  console.log("Done converting spell icons.");
})();