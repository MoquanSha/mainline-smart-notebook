const fs = require('node:fs');
const io = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const validation = new Map();

function imageExtension(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return '';
  if (bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    let offset = 8, header = false, pixels = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), kind = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      if (offset + 12 + length > bytes.length) return '';
      if (!header) {
        if (kind !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) return '';
        header = true;
      }
      if (kind === 'IDAT' && length) pixels = true;
      offset += length + 12;
      if (kind === 'IEND') return header && pixels && length === 0 && offset === bytes.length ? '.png' : '';
    }
    return '';
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, frame = false, scan = false;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) return '';
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      // Some phone motion photos append other media after the JPEG end marker.
      if (marker === 0xd9) return frame && scan ? '.jpg' : '';
      if (marker === 0 || marker === 0xd8 || marker === undefined) return '';
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return '';
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return '';
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return '';
        frame = true;
      }
      offset += length;
      if (marker === 0xda) {
        scan = true;
        while (offset + 1 < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue; }
          const next = bytes[offset + 1];
          if (next === 0xff) { offset++; continue; }
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
          break;
        }
      }
    }
    return '';
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let offset = 12, pixels = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.subarray(offset, offset + 4).toString('ascii'), length = bytes.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) return '';
      if (['VP8 ', 'VP8L', 'ANMF'].includes(kind) && length) pixels = true;
    }
    return pixels && offset === bytes.length ? '.webp' : '';
  }
  return '';
}

function hasImage(file, expectedSize = 0) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES || (Number(expectedSize) > 0 && stat.size !== Number(expectedSize))) return false;
    const signature = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
    const saved = validation.get(file);
    if (saved?.signature === signature) return saved.valid;
    const valid = Boolean(imageExtension(fs.readFileSync(file)));
    if (validation.size >= 512) validation.delete(validation.keys().next().value);
    validation.set(file, { signature, valid });
    return valid;
  } catch { return false; }
}

async function writeImage(directory, relativePath, bytes, assertCurrent = () => {}, filesystem = io) {
  const extension = imageExtension(bytes);
  if (!extension || !/^todo-image-\d+-[a-z0-9]+\.(jpg|png|webp)$/i.test(relativePath) || !relativePath.endsWith(extension)) throw new Error('图片不完整或缓存路径无效');
  const target = join(directory, relativePath), temporary = join(directory, relativePath + '.' + randomUUID() + '.pending');
  let file;
  try {
    assertCurrent();
    file = await filesystem.open(temporary, 'wx');
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    assertCurrent();
    await filesystem.rename(temporary, target);
    validation.delete(target);
    assertCurrent();
  } finally {
    if (file) await file.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = { imageExtension, hasImage, writeImage, MAX_BYTES };
