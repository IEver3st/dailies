import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
};

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

function findEndOfCentralDirectory(fd: number, fileSize: number) {
  const tailSize = Math.min(fileSize, 65557 + 20);
  const tail = readAt(fd, fileSize - tailSize, tailSize);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    let entries = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdOffset = tail.readUInt32LE(i + 16);
    const locator = i - 20;
    if (locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
      const zip64EocdOffset = Number(tail.readBigUInt64LE(locator + 8));
      const z = readAt(fd, zip64EocdOffset, 56);
      if (z.readUInt32LE(0) === 0x06064b50) {
        entries = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOffset = Number(z.readBigUInt64LE(48));
      }
    }
    return { entries, cdSize, cdOffset };
  }
  throw new Error("not a zip archive (no end of central directory)");
}

export function listZip(path: string): Map<string, ZipEntry> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const { entries, cdSize, cdOffset } = findEndOfCentralDirectory(fd, size);
    const cd = readAt(fd, cdOffset, cdSize);
    const out = new Map<string, ZipEntry>();
    let p = 0;
    for (let n = 0; n < entries && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      out.set(name, { name, method, crc, compressedSize, size: uncompressedSize, localHeaderOffset });
      p = extraEnd + commentLen;
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export function readZipEntry(path: string, entry: ZipEntry): Buffer {
  const fd = openSync(path, "r");
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
    const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = readAt(fd, dataStart, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip method ${entry.method} for ${entry.name}`);
  } finally {
    closeSync(fd);
  }
}

export function readZipJson<T>(path: string, name: string, entries = listZip(path)): T | undefined {
  const entry = entries.get(name);
  if (!entry) return undefined;
  return JSON.parse(readZipEntry(path, entry).toString("utf8")) as T;
}

export function entryDataStart(path: string, entry: ZipEntry): number {
  const fd = openSync(path, "r");
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
    return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    closeSync(fd);
  }
}
