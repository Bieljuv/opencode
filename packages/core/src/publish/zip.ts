export * as PublishZip from "./zip.js"

/**
 * Minimal ZIP writer (stored entries, no compression) for the project
 * download. No third-party archive library exists in this repo, and the
 * download must work on a fresh install without one. The output is
 * deterministic — fixed timestamps, entries in the order given — so a
 * download of the same project always produces the same bytes.
 */
export interface ZipEntry {
  readonly path: string
  readonly content: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff]
}

function u32(value: number): [number, number, number, number] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]
}

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: number[] = []
  const central: { path: Uint8Array; crc: number; size: number; offset: number }[] = []
  // Fixed DOS date/time (1980-01-01 00:00:00): the archive is deterministic.
  const time = 0
  const date = 0x21
  for (const entry of entries) {
    const path = new TextEncoder().encode(entry.path)
    const crc = crc32(entry.content)
    const offset = chunks.length
    chunks.push(
      0x50, 0x4b, 0x03, 0x04, // local file header signature
      ...u16(20), // version needed
      ...u16(0x0800), // flags: UTF-8 names
      ...u16(0), // method: stored
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(entry.content.length),
      ...u32(entry.content.length),
      ...u16(path.length),
      ...u16(0),
      ...path,
      ...entry.content,
    )
    central.push({ path, crc, size: entry.content.length, offset })
  }
  const centralOffset = chunks.length
  for (const record of central) {
    chunks.push(
      0x50, 0x4b, 0x01, 0x02, // central directory signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(0),
      ...u16(time),
      ...u16(date),
      ...u32(record.crc),
      ...u32(record.size),
      ...u32(record.size),
      ...u16(record.path.length),
      ...u16(0), // extra length
      ...u16(0), // comment length
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(record.offset),
      ...record.path,
    )
  }
  const centralSize = chunks.length - centralOffset
  chunks.push(
    0x50, 0x4b, 0x05, 0x06, // end of central directory signature
    ...u16(0),
    ...u16(0),
    ...u16(central.length),
    ...u16(central.length),
    ...u32(centralSize),
    ...u32(centralOffset),
    ...u16(0),
  )
  return new Uint8Array(chunks)
}
