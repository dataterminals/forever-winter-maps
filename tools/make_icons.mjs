// Generate PWA PNG icons with zero dependencies (Node built-in zlib only).
// Draws a dark rounded square with a brass map-pin + snowflake, matching icon.svg.
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../assets/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const COL = {
  bgTop: [0x20, 0x23, 0x21], bgBot: [0x12, 0x13, 0x13],
  line: [0x31, 0x35, 0x35],
  brassTop: [0xe0, 0xbd, 0x45], brassBot: [0xa9, 0x87, 0x1c],
  brassEdge: [0x7a, 0x63, 0x15], dark: [0x1a, 0x1a, 0x1a],
};
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// signed-distance helpers
function distSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  let t = (wx * vx + wy * vy) / (vx * vx + vy * vy);
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * vx, cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}
// teardrop pin path test (matches the SVG geometry, scaled to 512)
function pinDist(x, y) {
  // circle top centred (256,223) r~120, plus tip at (256,408)
  const cx = 256, cy = 223, r = 120;
  const dCircle = Math.hypot(x - cx, y - cy) - r;
  // triangle from tip to circle sides
  const dTri = distSegment(x, y, 256, 408, 152, 250) < 0 ? 0 : 0; // placeholder
  return dCircle;
}

function makeIcon(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const put = (x, y, rgb, a = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = a;
  };
  const radius = maskable ? size : 96 * s;        // maskable = no rounded corner clip
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-rect background mask
      let inside = true;
      if (!maskable) {
        const rx = Math.min(x, size - 1 - x), ry = Math.min(y, size - 1 - y);
        if (rx < radius && ry < radius) inside = Math.hypot(radius - rx, radius - ry) <= radius;
      }
      if (!inside) { put(x, y, [0, 0, 0], 0); continue; }
      let col = lerp(COL.bgTop, COL.bgBot, y / size);

      // inner border line
      if (!maskable) {
        const b = 14 * s, w = 6 * s, rr = 84 * s;
        const ix = Math.min(x - b, (size - 1 - b) - x), iy = Math.min(y - b, (size - 1 - b) - y);
        const onEdge = (ix >= 0 && iy >= 0) && (ix < w || iy < w) && (ix < rr && iy < rr ? Math.abs(Math.hypot(rr - ix, rr - iy) - rr) < w : (ix < w || iy < w));
        if (ix >= -w && iy >= -w && (Math.abs(ix) < w || Math.abs(iy) < w) && x > b && x < size - b && y > b && y < size - b) {
          if (ix < w || iy < w) col = COL.line;
        }
      }

      // pin (work in 512-space)
      const X = x / s, Y = y / s;
      const cx = 256, cy = 223, r = 120;
      const inCircle = Math.hypot(X - cx, Y - cy) <= r && Y <= cy + 40;
      // triangular tail towards the tip (256,410)
      const tipY = 410;
      let inTail = false;
      if (Y > cy - 10 && Y < tipY) {
        const tprog = (Y - (cy - 10)) / (tipY - (cy - 10));     // 0..1
        const halfW = (1 - tprog) * 120;                         // narrows to point
        inTail = Math.abs(X - 256) <= halfW;
      }
      if (inCircle || inTail) {
        // edge darkening
        let edge = false;
        const dC = Math.abs(Math.hypot(X - cx, Y - cy) - r);
        if (inCircle && dC < 7) edge = true;
        col = edge ? COL.brassEdge : lerp(COL.brassTop, COL.brassBot, Math.min(1, (Y - 100) / 320));

        // snowflake (dark) inside upper bulb
        const sx = 256, sy = 223;
        const d1 = distSegment(X, Y, sx, 176, sx, 270);
        const d2 = distSegment(X, Y, 215, 200, 297, 246);
        const d3 = distSegment(X, Y, 297, 200, 215, 246);
        const dCenter = Math.hypot(X - sx, Y - sy);
        if (Math.min(d1, d2, d3) < 8 || dCenter < 16) col = COL.dark;
      }
      put(x, y, col, 255);
    }
  }
  return buf;
}

// ---- minimal PNG encoder ----
function crc32(buf) {
  let c, table = crc32.t || (crc32.t = (() => {
    const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // filtered raw: prefix each scanline with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function write(name, size, maskable) {
  const png = encodePNG(makeIcon(size, maskable), size);
  writeFileSync(new URL(name, OUT), png);
  console.log('wrote', name, png.length, 'bytes');
}

write('icon-512.png', 512, false);
write('icon-192.png', 192, false);
write('icon-maskable-512.png', 512, true);
console.log('done');
