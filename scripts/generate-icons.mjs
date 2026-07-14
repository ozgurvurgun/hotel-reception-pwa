import sharp from 'sharp';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const iconsDir = join(root, 'public', 'icons');
const source = join(iconsDir, 'logo-source.png');

const SIZES = [16, 32, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512];

async function generateIcon(size, { maskable = false } = {}) {
  const scale = maskable ? 0.72 : 1;
  const inner = Math.max(1, Math.round(size * scale));

  const logo = await sharp(source)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .png()
    .toBuffer();

  const filename = maskable ? `icon-maskable-${size}.png` : `icon-${size}.png`;

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(join(iconsDir, filename));

  console.log(`Created ${filename}`);
}

await mkdir(iconsDir, { recursive: true });

for (const size of SIZES) {
  await generateIcon(size);
}

await generateIcon(192, { maskable: true });
await generateIcon(512, { maskable: true });

console.log('All PWA icons generated.');
