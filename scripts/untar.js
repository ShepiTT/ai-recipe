// Minimal .tgz extractor (ustar format) — no external deps
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [tgzPath, destDir] = process.argv.slice(2);
if (!tgzPath || !destDir) {
  console.error('usage: node untar.js <file.tgz> <destDir>');
  process.exit(1);
}

const gz = fs.readFileSync(tgzPath);
const tar = zlib.gunzipSync(gz);

let off = 0;
let links = [];
while (off + 512 <= tar.length) {
  const header = tar.subarray(off, off + 512);
  if (header.every((b) => b === 0)) break; // end of archive
  const name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '');
  let size = parseInt(header.subarray(124, 136).toString('utf8').replace(/[\0 ]+$/g, ''), 8) || 0;
  const typeflag = String.fromCharCode(header[156] || 48);
  const linkname = header.subarray(157, 257).toString('utf8').replace(/\0+$/, '');
  const fullName = path.join(destDir, prefix ? path.join(prefix, name) : name);

  if (typeflag === '5') {
    fs.mkdirSync(fullName, { recursive: true });
  } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
    const dataEnd = off + 512 + size;
    const data = tar.subarray(off + 512, Math.min(dataEnd, tar.length));
    fs.mkdirSync(path.dirname(fullName), { recursive: true });
    fs.writeFileSync(fullName, data);
    off = dataEnd;
    // advance to next 512 boundary
    const rem = size % 512;
    if (rem !== 0) off += 512 - rem;
    continue;
  } else if (typeflag === '1' || typeflag === '2') {
    links.push([fullName, linkname]);
  }
  off += 512;
  const rem2 = size % 512;
  if (rem2 !== 0 && typeflag !== '5') off += 512 - rem2;
}
for (const [linkPath, target] of links) {
  try { fs.symlinkSync(target, linkPath); } catch {}
}
console.log('extracted to', destDir);
