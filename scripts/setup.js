import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { webcrypto } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);
const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
const publicKey = bytesToBase64Url(publicRaw);
const privateKey = privateJwk.d;

console.log('Generated VAPID keys (keep private key as Cloudflare secret)');
console.log('Public:', publicKey);

const wranglerPath = join(root, 'wrangler.toml');
let wrangler = readFileSync(wranglerPath, 'utf8');
wrangler = wrangler.replace(/VAPID_PUBLIC_KEY = ".*"/, `VAPID_PUBLIC_KEY = "${publicKey}"`);
writeFileSync(wranglerPath, wrangler);
console.log('Updated wrangler.toml public key');
console.log('Set secret: npx wrangler secret put VAPID_PRIVATE_KEY');
console.log('Value:', privateKey);

const iconsDir = join(root, 'public', 'icons');
mkdirSync(iconsDir, { recursive: true });

function createSVG(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#007AFF"/><stop offset="100%" style="stop-color:#5856D6"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#g)"/>
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
      font-family="-apple-system,sans-serif" font-size="${Math.round(size * 0.45)}" font-weight="700" fill="white">H</text>
  </svg>`;
}

for (const size of [192, 512]) {
  writeFileSync(join(iconsDir, `icon-${size}.svg`), createSVG(size));
}

console.log('Setup complete! Next: npm run db:init && npm run dev');
