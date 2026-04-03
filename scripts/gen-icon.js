// Generates resources/icon.png (128x128) using only Node.js built-ins
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 128, H = 128;
const img = Buffer.alloc(W * H * 4, 0); // RGBA, fully transparent

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = r; img[i+1] = g; img[i+2] = b; img[i+3] = a;
}

function rect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      px(x, y, r, g, b, a);
}

function ellipse(cx, cy, rx, ry, r, g, b, a = 255) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
      if ((x - cx) ** 2 / rx ** 2 + (y - cy) ** 2 / ry ** 2 <= 1)
        px(x, y, r, g, b, a);
}

// Rounded blue background
const CORNER = 22;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = Math.max(0, Math.max(CORNER - x, x - (W - 1 - CORNER)));
  const dy = Math.max(0, Math.max(CORNER - y, y - (H - 1 - CORNER)));
  if (dx * dx + dy * dy <= CORNER * CORNER)
    px(x, y, 28, 100, 210);
}

// Cylinder icon
const cx = 64, top = 36, bot = 92, rx = 30, ry = 9;

// Cylinder body
for (let y = top; y <= bot; y++)
  for (let x = cx - rx; x <= cx + rx; x++)
    px(x, y, 100, 180, 255);

// Shading: left/right edges darker
for (let y = top; y <= bot; y++) {
  for (let d = 0; d < 6; d++) {
    const alpha = Math.round(80 * (1 - d / 6));
    // blend darker on sides
    const blend = (base, dark) => Math.round(base * (1 - alpha/255) + dark * (alpha/255));
    const xi = cx - rx + d;
    const xj = cx + rx - d;
    px(xi, y, blend(100, 30), blend(180, 80), blend(255, 180));
    px(xj, y, blend(100, 30), blend(180, 80), blend(255, 180));
  }
}

// Row separator lines
for (const ly of [54, 67, 80])
  rect(cx - rx + 3, ly, cx + rx - 3, ly + 1, 30, 90, 190);

// Bottom ellipse
ellipse(cx, bot, rx, ry, 50, 140, 230);

// Top ellipse (highlight)
ellipse(cx, top, rx, ry, 180, 225, 255);

// ── PNG encoder ──────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA

// Raw scanlines (filter byte 0 = None)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}

const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(dest, png);
console.log('Created:', dest);
