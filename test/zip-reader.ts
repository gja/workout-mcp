// A ZIP reader for the tests, shared by the recordings archive and the context backup.

/**
 * A ZIP reader, deliberately not the writer's mirror image.
 *
 * It works the way a real one does — find the end-of-central-directory, walk
 * the directory, take each file's size and offset from *there* — so the test
 * only passes if what was written is an archive rather than a shape this
 * project agrees with itself about. The CRC is recomputed from scratch.
 */
export type Extracted = { name: string; content: string; crcMatches: boolean };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function readZip(bytes: Uint8Array): Extracted[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x0605_4b50) end -= 1;
  if (end < 0) throw new Error('no end-of-central-directory record: this is not a ZIP');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  const files: Extracted[] = [];
  for (let seen = 0; seen < count; seen += 1) {
    if (view.getUint32(at, true) !== 0x0201_4b50) throw new Error('central directory entry is not one');

    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // The local header again at the file's own offset, and the data after it.
    if (view.getUint32(offset, true) !== 0x0403_4b50) throw new Error(`${name} has no local header`);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const content = bytes.subarray(start, start + size);

    files.push({ name, content: new TextDecoder().decode(content), crcMatches: crc32(content) === crc });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
