// A ZIP written as it goes out: one entry at a time, nothing buffered but the
// chunk in hand. That is what lets a month of recordings leave a Worker that
// could never hold them all at once. See docs/recordings.md.

const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/**
 * Bit 3 puts the CRC and the two sizes *after* the data, in a descriptor, which
 * is the whole trick: none of the three is known until the file has been read,
 * and by then its local header has long since gone out on the wire. Bit 11 says
 * the name is UTF-8 rather than the ancient code page.
 */
const FLAGS = 0x0008 | 0x0800;

/**
 * Stored, not deflated — and that is a decision, not a shortcut.
 *
 * CPU is the scarce thing in a Worker, not bandwidth: an archive is built
 * inside one request's budget, and deflating every byte on the way out spends
 * that budget to save very little. A FIT file is already packed binary, so it
 * gives back only a few per cent. The CRC below is the one pass that cannot be
 * skipped — a ZIP without it is one a reader calls corrupt — so it is the only
 * per-byte work here, and the copy is otherwise a straight relay.
 */
const STORED = 0;

/** What a version-2.0 reader understands, which is everything used here. */
const VERSION = 20;

const UINT32_MAX = 0xffff_ffff;
const UINT16_MAX = 0xffff;

// --- CRC-32 ------------------------------------------------------------------

let table: Uint32Array | undefined;

/** Built once, on the first entry: 256 words the alternative spends per byte. */
function crcTable(): Uint32Array {
  if (table) return table;
  const built = new Uint32Array(256);
  for (let at = 0; at < 256; at += 1) {
    let value = at;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    built[at] = value >>> 0;
  }
  table = built;
  return built;
}

/** Fed chunk by chunk, so it runs alongside the copy rather than after it. */
const crcUpdate = (crc: number, bytes: Uint8Array): number => {
  const lookup = crcTable();
  let value = crc;
  for (let at = 0; at < bytes.length; at += 1) value = lookup[(value ^ bytes[at]) & 0xff] ^ (value >>> 8);
  return value >>> 0;
};

const CRC_INIT = 0xffff_ffff;
const crcFinal = (crc: number): number => (crc ^ CRC_INIT) >>> 0;

// --- Bytes -------------------------------------------------------------------

/** Every field in a ZIP is little-endian, so the writer only ever needs these two. */
class Bytes {
  private readonly view: DataView;
  private at = 0;

  constructor(readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }

  raw(value: Uint8Array): this {
    this.buffer.set(value, this.at);
    this.at += value.length;
    return this;
  }
}

const encoder = new TextEncoder();

/** DOS packs a timestamp into two 16-bit words, from 1980, at two-second resolution. */
const dosTime = (when: Date): number =>
  (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);

const dosDate = (when: Date): number => {
  const year = Math.max(1980, when.getUTCFullYear());
  return ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
};

// --- Entries -----------------------------------------------------------------

/** One file to put in the archive. The body is a stream or the bytes themselves. */
export type ZipEntry = {
  /** The path inside the archive. Forward slashes make folders. */
  name: string;
  /** Shown as the file's date. Defaults to now. */
  modified?: Date;
  body: ReadableStream<Uint8Array> | Uint8Array;
};

type Written = {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

const localHeader = (name: Uint8Array, time: number, date: number): Uint8Array => {
  const bytes = new Uint8Array(30 + name.length);
  new Bytes(bytes)
    .u32(LOCAL_HEADER)
    .u16(VERSION)
    .u16(FLAGS)
    .u16(STORED)
    .u16(time)
    .u16(date)
    // Three zeroes standing in for the CRC and the sizes: the descriptor carries them.
    .u32(0)
    .u32(0)
    .u32(0)
    .u16(name.length)
    .u16(0)
    .raw(name);
  return bytes;
};

const dataDescriptor = (crc: number, size: number): Uint8Array => {
  const bytes = new Uint8Array(16);
  new Bytes(bytes).u32(DATA_DESCRIPTOR).u32(crc).u32(size).u32(size);
  return bytes;
};

const centralHeader = (entry: Written): Uint8Array => {
  const bytes = new Uint8Array(46 + entry.name.length);
  new Bytes(bytes)
    .u32(CENTRAL_HEADER)
    .u16(VERSION)
    .u16(VERSION)
    .u16(FLAGS)
    .u16(STORED)
    .u16(entry.time)
    .u16(entry.date)
    .u32(entry.crc)
    .u32(entry.size)
    .u32(entry.size)
    .u16(entry.name.length)
    // No extra field, no comment, disk zero, and no attributes worth claiming.
    .u16(0)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(0)
    .u32(entry.offset)
    .raw(entry.name);
  return bytes;
};

const endOfCentralDirectory = (count: number, size: number, offset: number): Uint8Array => {
  const bytes = new Uint8Array(22);
  new Bytes(bytes)
    .u32(END_OF_CENTRAL)
    .u16(0)
    .u16(0)
    .u16(count)
    .u16(count)
    .u32(size)
    .u32(offset)
    .u16(0);
  return bytes;
};

/**
 * The archive as a stream, built from entries produced as they are needed.
 *
 * The source is an async iterable rather than an array because each entry is a
 * download from someone else's server: asking for them all up front would mean
 * holding every response open while the first one is copied.
 *
 * Plain ZIP, not ZIP64, so nothing here may cross 4 GiB or 65,535 entries. Both
 * are thrown on rather than written wrong, because a reader meeting a truncated
 * 32-bit size reports a corrupt archive and not the reason for it. The caller
 * that fills this — `src/recordings/` — caps the count long before either bites.
 */
export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const build = async (): Promise<void> => {
    const written: Written[] = [];
    let offset = 0;

    const put = async (bytes: Uint8Array): Promise<void> => {
      await writer.write(bytes);
      offset += bytes.length;
    };

    for await (const entry of entries) {
      if (written.length === UINT16_MAX) throw new Error('too many files for a ZIP archive');

      const name = encoder.encode(entry.name);
      const when = entry.modified ?? new Date();
      const time = dosTime(when);
      const date = dosDate(when);
      const start = offset;

      await put(localHeader(name, time, date));

      let crc = CRC_INIT;
      let size = 0;
      const absorb = async (chunk: Uint8Array): Promise<void> => {
        crc = crcUpdate(crc, chunk);
        size += chunk.length;
        if (size > UINT32_MAX) throw new Error(`${entry.name} is too large for a ZIP archive`);
        await put(chunk);
      };

      if (entry.body instanceof Uint8Array) {
        await absorb(entry.body);
      } else {
        const reader = entry.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) await absorb(value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      await put(dataDescriptor(crcFinal(crc), size));
      written.push({ name, crc: crcFinal(crc), size, offset: start, time, date });
    }

    const directory = offset;
    for (const entry of written) await put(centralHeader(entry));
    const directorySize = offset - directory;

    if (offset > UINT32_MAX) throw new Error('archive is too large for a ZIP without ZIP64');
    await writer.write(endOfCentralDirectory(written.length, directorySize, directory));
    await writer.close();
  };

  // Deliberately not awaited: the response goes out while this is still filling
  // it. An abort is how a reader learns the archive stopped being trustworthy —
  // a closed stream would look like a complete, and shorter, download.
  void build().catch((err: unknown) => {
    console.error('building the ZIP failed part way through', err);
    void writer.abort(err);
  });

  return readable;
}
