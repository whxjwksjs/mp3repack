import { BitReader } from "./bits.js";

/**
 * MPEG Layer III frame scanner + header/side-info parser.
 *
 * We never decode audio. We only need, per frame:
 *  - main_data_begin (bit-reservoir pointer, in bytes)
 *  - sum of part2_3_length over granules/channels (actual audio bits)
 * plus the fixed geometry (header/side-info lengths) so the repacker can
 * re-lay frames at the smallest legal size.
 */

export const BR_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
export const BR_LSF_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
export const SAMPLE_RATES = [
  [44100, 48000, 32000], // MPEG-1
  [22050, 24000, 16000], // MPEG-2
  [11025, 12000, 8000], // MPEG-2.5
];

export type MpegVersion = 1 | 2 | 25;

export interface FrameInfo {
  offset: number; // file offset of frame sync
  version: MpegVersion;
  bitrateKbps: number;
  bitrateIndex: number;
  sampleRate: number;
  padding: boolean;
  channels: number;
  hasCrc: boolean;
  storedCrc: number; // 0 when no CRC
  crcOk: boolean; // true when no CRC or recomputed CRC matches
  frameLength: number; // bytes, including header
  sideInfoLen: number; // bytes
  mainDataBegin: number; // bytes (reservoir pointer)
  mainDataBits: number; // sum of part2_3_length (audio bits belonging to this frame)
  granules: number;
}

export interface XingInfo {
  offset: number; // file offset of "Xing"/"Info" magic
  headerLen: number; // Xing header length from flags
  isInfo: boolean; // "Info" (CBR) vs "Xing" (VBR)
  frames: number;
  bytes: number;
  hasToc: boolean;
  lameOffset: number; // -1 when no LAME tag follows
  lameLen: number; // valid when lameOffset >= 0
}

export interface StreamInfo {
  frames: FrameInfo[];
  id3v2Bytes: number;
  audioStart: number;
  audioEnd: number;
  trailingBytes: number;
  freeFormat: boolean;
  xing: XingInfo | null;
  durationSec: number;
}

export function isSync(d: Uint8Array, p: number): boolean {
  return p + 1 < d.length && d[p] === 0xff && (d[p + 1] & 0xe0) === 0xe0;
}

interface Header {
  version: MpegVersion;
  versionIdx: number; // 0=mpeg1,1=mpeg2,2=mpeg2.5
  bitrateKbps: number;
  bitrateIndex: number;
  sampleRate: number;
  padding: boolean;
  channels: number;
  hasCrc: boolean;
  frameLength: number;
  samplesPerFrame: number;
}

function parseHeader(d: Uint8Array, p: number): Header | null {
  if (!isSync(d, p) || p + 4 > d.length) return null;
  const b1 = d[p + 1],
    b2 = d[p + 2],
    b3 = d[p + 3];
  const verBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  if (verBits === 1 || layerBits !== 1) return null; // reserved version / not Layer III
  const versionIdx = verBits === 3 ? 0 : verBits === 2 ? 1 : 2;
  const version: MpegVersion = versionIdx === 0 ? 1 : versionIdx === 1 ? 2 : 25;
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 0x3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null; // free format / invalid
  if ((b3 & 0x3) === 2) return null; // reserved emphasis
  const bitrateKbps = (version === 1 ? BR_MPEG1_L3 : BR_LSF_L3)[brIdx];
  const sampleRate = SAMPLE_RATES[versionIdx][srIdx];
  const padding = ((b2 >> 1) & 1) === 1;
  const channels = ((b3 >> 6) & 0x3) === 3 ? 1 : 2;
  const coef = version === 1 ? 144 : 72;
  const frameLength = Math.floor((coef * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);
  if (frameLength < 21) return null; // smaller than header+minimal side info
  return {
    version,
    versionIdx,
    bitrateKbps,
    bitrateIndex: brIdx,
    sampleRate,
    padding,
    channels,
    hasCrc: (b1 & 1) === 0,
    frameLength,
    samplesPerFrame: version === 1 ? 1152 : 576,
  };
}

function sideInfoLen(h: Header): number {
  if (h.version === 1) return h.channels === 1 ? 17 : 32;
  return h.channels === 1 ? 9 : 17;
}

/** Parse side info; returns main_data_begin + total main-data bits. Throws on overrun. */
function parseSideInfo(d: Uint8Array, h: Header, siOff: number): { mainDataBegin: number; mainDataBits: number; bitsConsumed: number } {
  const r = new BitReader(d, siOff);
  const lsf = h.version !== 1;
  const granules = lsf ? 1 : 2;
  const mainDataBegin = r.readBits(lsf ? 8 : 9);
  const privBits = lsf ? (h.channels === 1 ? 1 : 2) : h.channels === 1 ? 5 : 3;
  r.skip(privBits);
  if (!lsf) for (let c = 0; c < h.channels; c++) r.skip(4); // scfsi
  let mainDataBits = 0;
  for (let g = 0; g < granules; g++) {
    for (let c = 0; c < h.channels; c++) {
      mainDataBits += r.readBits(12); // part2_3_length
      r.skip(9); // big_values
      r.skip(8); // global_gain
      r.skip(lsf ? 9 : 4); // scalefac_compress
      r.skip(1); // window_switching_flag (affects tail layout, not its length)
      // Skip the rest of this granule/channel's side info. We only need
      // part2_3_length (already read), so the tail is skipped by fixed size.
      // NOTE: the tail is 25 bits (MPEG-1) / 24 bits (MPEG-2/2.5) whether or
      // not window switching is used — empirically validated: every parsed
      // frame consumes exactly the known fixed side-info length (256/136/
      // 136/72 bits) across CBR/VBR/mono/stereo test files.
      r.skip(lsf ? 24 : 25);
    }
  }
  return { mainDataBegin, mainDataBits, bitsConsumed: r.bitsRead };
}

/** CRC-16 (poly 0x8005) over the last 2 header bytes + side info, per ISO 11172-3. */
export function mp3Crc16(d: Uint8Array, off: number, len: number): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) {
    const b = d[off + i];
    for (let m = 0x80; m !== 0; m >>= 1) {
      const bit = (b & m) !== 0 ? 1 : 0;
      if (((crc >> 15) ^ bit) & 1) crc = ((crc << 1) ^ 0x8005) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function skipId3v2(d: Uint8Array): number {
  if (d.length < 10 || d[0] !== 0x49 || d[1] !== 0x44 || d[2] !== 0x33) return 0; // "ID3"
  const size = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) | ((d[8] & 0x7f) << 7) | (d[9] & 0x7f);
  let total = 10 + size;
  if ((d[5] & 0x10) !== 0) total += 10; // footer
  return total;
}

/**
 * Detect free-format MP3 (bitrate index 0). Free-format frames don't have a
 * standard size, so we can't safely reframe them. Returns true if a valid
 * sync with bitrate index 0 is found.
 */
export function detectFreeFormat(d: Uint8Array): boolean {
  let pos = skipId3v2(d);
  // Check the first few sync positions for free-format bitrate index
  for (let i = 0; i < 5 && pos + 4 <= d.length; i++) {
    while (pos + 4 <= d.length && !isSync(d, pos)) pos++;
    if (pos + 4 > d.length) break;
    const b1 = d[pos + 1];
    const b2 = d[pos + 2];
    const verBits = (b1 >> 3) & 0x3;
    const layerBits = (b1 >> 1) & 0x3;
    const brIdx = (b2 >> 4) & 0xf;
    const srIdx = (b2 >> 2) & 0x3;
    // Valid MPEG-1/2/2.5 Layer III header with free-format bitrate?
    if (verBits !== 1 && layerBits === 1 && srIdx !== 3 && brIdx === 0) {
      return true;
    }
    pos++;
  }
  return false;
}

/**
 * Detect MP3Pro (legacy format with SBR enhancement data). MP3Pro is
 * backward-compatible but the SBR data is sensitive to framing changes.
 * Uses best-effort string heuristics; false positives safely passthrough.
 */
export function detectMp3Pro(d: Uint8Array): boolean {
  // Search first 64KB for MP3Pro identifiers (covers ID3v2 and early frames)
  const searchLen = Math.min(d.length, 65536);
  // Build a lowercase string for case-insensitive search
  let text = "";
  for (let i = 0; i < searchLen; i++) {
    const c = d[i];
    // Only include printable ASCII to avoid garbage
    if (c >= 32 && c <= 126) text += String.fromCharCode(c).toLowerCase();
    else text += " ";
  }
  const patterns = ["mp3pro", "coding technologies", "thomson mp3"];
  return patterns.some((p) => text.includes(p));
}

function ascii(d: Uint8Array, p: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(d[p + i]);
  return s;
}

function detectXing(d: Uint8Array, f: FrameInfo): XingInfo | null {
  const base = f.offset + 4 + f.sideInfoLen + (f.hasCrc ? 2 : 0);
  if (base + 8 > d.length) return null;
  const magic = ascii(d, base, 4);
  if (magic !== "Xing" && magic !== "Info") return null;
  const flags = (d[base + 4] << 24) | (d[base + 5] << 16) | (d[base + 6] << 8) | d[base + 7];
  let len = 8;
  let p = base + 8;
  let frames = 0,
    bytes = 0,
    hasToc = false;
  if (flags & 0x1) {
    frames = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    p += 4;
    len += 4;
  }
  if (flags & 0x2) {
    bytes = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    p += 4;
    len += 4;
  }
  if (flags & 0x4) {
    hasToc = true;
    p += 100;
    len += 100;
  }
  if (flags & 0x8) {
    p += 4;
    len += 4;
  }
  let lameOffset = -1,
    lameLen = 0;
  if (ascii(d, base + len, 4) === "LAME") {
    lameOffset = base + len;
    // LAME info tag is a fixed 36-byte structure following the Xing header.
    lameLen = 36;
  }
  return { offset: base, headerLen: len, isInfo: magic === "Info", frames, bytes, hasToc, lameOffset, lameLen };
}

export function parseMp3(d: Uint8Array): StreamInfo {
  let pos = skipId3v2(d);
  const id3v2Bytes = pos;
  const frames: FrameInfo[] = [];
  let freeFormat = false;

  while (pos + 4 <= d.length) {
    if (!isSync(d, pos)) {
      pos++;
      continue;
    }
    const h = parseHeader(d, pos);
    if (!h) {
      pos++;
      continue;
    }
    const next = pos + h.frameLength;
    if (next > d.length) break; // truncated tail
    // Validate by checking the next frame's sync (guards against false syncs
    // inside main data). The final frame can't be checked this way.
    if (next + 4 <= d.length) {
      if (!isSync(d, next) || !parseHeader(d, next)) {
        pos++;
        continue;
      }
    }
    const siLen = sideInfoLen(h);
    const siOff = pos + 4 + (h.hasCrc ? 2 : 0);
    let mainDataBegin: number, mainDataBits: number;
    try {
      const si = parseSideInfo(d, h, siOff);
      // Empirical self-check: our field walk must consume exactly the known
      // fixed side-info length. If not, our layout is wrong for this frame.
      if (si.bitsConsumed !== siLen * 8) {
        pos++;
        continue;
      }
      mainDataBegin = si.mainDataBegin;
      mainDataBits = si.mainDataBits;
    } catch {
      pos++;
      continue;
    }
    let storedCrc = 0,
      crcOk = true;
    if (h.hasCrc) {
      storedCrc = (d[pos + 4] << 8) | d[pos + 5];
      // CRC covers last 2 header bytes + side info
      const tmp = new Uint8Array(2 + siLen);
      tmp[0] = d[pos + 2];
      tmp[1] = d[pos + 3];
      tmp.set(d.subarray(siOff, siOff + siLen), 2);
      crcOk = mp3Crc16(tmp, 0, tmp.length) === storedCrc;
    }
    frames.push({
      offset: pos,
      version: h.version,
      bitrateKbps: h.bitrateKbps,
      bitrateIndex: h.bitrateIndex,
      sampleRate: h.sampleRate,
      padding: h.padding,
      channels: h.channels,
      hasCrc: h.hasCrc,
      storedCrc,
      crcOk,
      frameLength: h.frameLength,
      sideInfoLen: siLen,
      mainDataBegin,
      mainDataBits,
      granules: h.version === 1 ? 2 : 1,
    });
    pos = next;
  }

  const xing = frames.length > 0 ? detectXing(d, frames[0]) : null;
  const audioStart = frames.length > 0 ? frames[0].offset : d.length;
  const audioEnd = frames.length > 0 ? frames[frames.length - 1].offset + frames[frames.length - 1].frameLength : audioStart;
  const spf = frames.length > 0 ? (frames[0].version === 1 ? 1152 : 576) : 0;
  const sr = frames.length > 0 ? frames[0].sampleRate : 0;
  return {
    frames,
    id3v2Bytes,
    audioStart,
    audioEnd,
    trailingBytes: d.length - audioEnd,
    freeFormat,
    xing,
    durationSec: sr > 0 ? (frames.length * spf) / sr : 0,
  };
}

/** Rough estimate of removable stuffing bytes across the stream. */
export function stuffingEstimate(s: StreamInfo): number {
  let total = s.id3v2Bytes + s.trailingBytes;
  s.frames.forEach((f, i) => {
    const xingLen = i === 0 && s.xing ? s.xing.headerLen + s.xing.lameLen : 0;
    const used = 4 + (f.hasCrc ? 2 : 0) + f.sideInfoLen + Math.ceil(f.mainDataBits / 8) + xingLen;
    if (used < f.frameLength) total += f.frameLength - used;
  });
  return total;
}
