const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const inputDir = "./public/icons/weapons/shield";   // change if needed
const outputDir = "./public/icons/weapon/shield";

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function convertImages() {
  const files = fs.readdirSync(inputDir);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (![".png", ".jpg", ".jpeg"].includes(ext)) continue;

    const inputPath = path.join(inputDir, file);
    const outputPath = path.join(
      outputDir,
      path.basename(file, ext) + ".webp"
    );

    try {
      await sharp(inputPath)
        .resize(128, 128, {
          fit: "inside",
          withoutEnlargement: true
        })
        .webp({
          quality: 85,
          alphaQuality: 100
        })
        .toFile(outputPath);

      console.log("✔ Converted:", file);
    } catch (err) {
      console.error("✖ Error:", file, err);
    }
  }

  console.log("Done converting ranger spells.");
}

convertImages();