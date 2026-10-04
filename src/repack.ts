import { parseMp3, mp3Crc16, FrameInfo, BR_MPEG1_L3, BR_LSF_L3, SAMPLE_RATES, detectFreeFormat, detectMp3Pro } from "./mp3.js";

/**
 * Lossless MP3 repacker.
 *
 * Model: the "main data stream" S is the concatenation of every frame's
 * main-data area A_j = [sync_j + H_j, sync_j + frameLength_j), where
 * H_j = 4 + crc + sideInfo. Per the MPEG spec, main_data_begin counts
 * *main-data bytes only* (headers/side info are not taken into account), so
 * frame i's audio lives at S[C_i - mainDataBegin_i], C_i = start of A_i in S,
 * and is mainDataBits_i bits long. Consecutive frames' audio is contiguous
 * in S (verified empirically against LAME output and minimp3's model).
 *
 * Repack: extract each frame's audio bytes from S into a compact pool, then
 * re-emit every frame at the smallest legal frame size that fits, preserving
 * the bit reservoir via rewritten main_data_begin pointers. The pool is
 * placed contiguously in the output S'; frame i's mdb' = C'[i] - poolStart - Q[i].
 *
 * If frame 0 has a Xing/Info tag, it is kept byte-identical (decoders do not
 * add the Xing frame's area to the reservoir, so the pool starts after
 * frame 0 and frame 1 is self-contained). Otherwise frame 0 is repacked too.
 *
 * Decoded audio is bit-identical (verified via ffmpeg PCM MD5); only framing
 * changes. No audio recompression, no decode/re-encode.
 */

export interface RepackResult {
  output: Uint8Array;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  passthrough: boolean;
  reason?: string;
}

const LAME_TAG_LEN = 38; // "LAME"+version .. Info Tag CRC-16, per mp3infotag spec

function headerLen(f: FrameInfo): number {
  return 4 + (f.hasCrc ? 2 : 0) + f.sideInfoLen;
}

function versionIdx(f: FrameInfo): number {
  return f.version === 1 ? 0 : f.version === 2 ? 1 : 2;
}

function sampleRateIdx(f: FrameInfo): number {
  const idx = SAMPLE_RATES[versionIdx(f)].indexOf(f.sampleRate);
  if (idx < 0) throw new Error("unknown sample rate");
  return idx;
}

function versionBits(f: FrameInfo): number {
  return f.version === 1 ? 0b11 : f.version === 2 ? 0b10 : 0b00;
}

function bitrateTable(f: FrameInfo): number[] {
  return f.version === 1 ? BR_MPEG1_L3 : BR_LSF_L3;
}

function frameLengthFor(f: FrameInfo, brIdx: number, pad: boolean): number {
  const br = bitrateTable(f)[brIdx];
  const coef = f.version === 1 ? 144 : 72;
  return Math.floor((coef * br * 1000) / f.sampleRate) + (pad ? 1 : 0);
}

/** Smallest (bitrateIdx, padding) whose frame length fits `needed` bytes. */
function pickFrameSize(f: FrameInfo, needed: number): { brIdx: number; pad: boolean; len: number } {
  const table = bitrateTable(f);
  for (let brIdx = 1; brIdx <= 14; brIdx++) {
    if (table[brIdx] === 0) continue;
    for (const pad of [false, true]) {
      const len = frameLengthFor(f, brIdx, pad);
      if (len >= needed) return { brIdx, pad, len };
    }
  }
  throw new Error(`no legal frame size fits ${needed} bytes`);
}

/** Copy S[a:b] (main-data-stream positions) from input to out at outPos. */
function copySRange(
  input: Uint8Array,
  frames: FrameInfo[],
  areaStart: number[],
  a: number,
  b: number,
  out: Uint8Array,
  outPos: number
): void {
  for (let j = 0; j < frames.length && a < b; j++) {
    const cs = areaStart[j];
    const ce = j + 1 < frames.length ? areaStart[j + 1] : cs + (frames[j].frameLength - headerLen(frames[j]));
    const lo = Math.max(a, cs);
    const hi = Math.min(b, ce);
    if (hi > lo) {
      const f = frames[j];
      const filePos = f.offset + headerLen(f) + (lo - cs);
      out.set(input.subarray(filePos, filePos + (hi - lo)), outPos + (lo - a));
    }
  }
}

function isLameTag(d: Uint8Array, p: number): boolean {
  if (p + 9 > d.length) return false;
  const magic = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);
  // "LAME" (real LAME) or "Lavc" (ffmpeg's libmp3lame variant). Both use the
  // same 38-byte info tag format with gapless delay/padding.
  if (magic !== "LAME" && magic !== "Lavc") return false;
  // version string like "3.100" or "62.28": digit(s), '.', digit(s)
  const v = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7], d[p + 8]);
  return /^\d+\.\d+$/.test(v);
}

/** 120-byte Xing/Info header (all flags set). */
function buildXing(nFrames: number, newLens: number[], totalBytes: number, isVbr: boolean): Uint8Array {
  const xing = new Uint8Array(120);
  const magic = isVbr ? "Xing" : "Info";
  for (let i = 0; i < 4; i++) xing[i] = magic.charCodeAt(i);
  xing[7] = 0x0f; // flags: frames | bytes | TOC | quality
  const audioFrames = nFrames - 1; // exclude the Info/Xing frame itself (LAME convention)
  xing[8] = (audioFrames >>> 24) & 0xff;
  xing[9] = (audioFrames >>> 16) & 0xff;
  xing[10] = (audioFrames >>> 8) & 0xff;
  xing[11] = audioFrames & 0xff;
  xing[12] = (totalBytes >>> 24) & 0xff;
  xing[13] = (totalBytes >>> 16) & 0xff;
  xing[14] = (totalBytes >>> 8) & 0xff;
  xing[15] = totalBytes & 0xff;
  // TOC: byte offset of the frame at each 1% of the file
  let bytePos = 0;
  const offsets: number[] = [];
  for (const len of newLens) {
    offsets.push(bytePos);
    bytePos += len;
  }
  for (let i = 0; i < 100; i++) {
    const targetFrame = Math.min(nFrames - 1, Math.floor((i / 100) * nFrames));
    xing[16 + i] = Math.min(255, Math.floor((256 * offsets[targetFrame]) / totalBytes));
  }
  // quality: 0
  return xing;
}

export interface RepackOptions {
  /** Preserve ID3v2 tag (default: false, tag is stripped) */
  preserveId3v2?: boolean;
}

export function repackMp3(input: Uint8Array, options: RepackOptions = {}): RepackResult {
  // Safety checks: free-format and MP3Pro must passthrough byte-identically.
  // Free-format has non-standard frame sizes we can't reframe safely.
  // MP3Pro hides SBR enhancement data sensitive to framing changes.
  if (detectFreeFormat(input)) {
    return {
      output: input,
      inputBytes: input.length,
      outputBytes: input.length,
      savedBytes: 0,
      passthrough: true,
      reason: "free-format stream (byte-identical passthrough)",
    };
  }
  if (detectMp3Pro(input)) {
    return {
      output: input,
      inputBytes: input.length,
      outputBytes: input.length,
      savedBytes: 0,
      passthrough: true,
      reason: "MP3Pro stream detected (byte-identical passthrough)",
    };
  }

  const s = parseMp3(input);
  const frames = s.frames;
  const fail = (reason: string): RepackResult => ({
    output: input,
    inputBytes: input.length,
    outputBytes: input.length,
    savedBytes: 0,
    passthrough: true,
    reason,
  });

  if (s.freeFormat) return fail("free-format stream (unsupported)");
  if (frames.length === 0) return fail("no MP3 frames found");
  const v0 = frames[0].version;
  const sr0 = frames[0].sampleRate;
  if (frames.some((f) => f.version !== v0 || f.sampleRate !== sr0)) return fail("mixed MPEG versions/sample rates");

  const n = frames.length;
  const H = frames.map(headerLen);
  // C[j]: start of frame j's main-data area in S
  const C: number[] = new Array(n);
  let acc = 0;
  for (let j = 0; j < n; j++) {
    C[j] = acc;
    acc += frames[j].frameLength - H[j];
  }
  const sLen = acc;

  // --- Xing / LAME tag (frame 0) ---
  const xing = s.xing;
  let lameTag: Uint8Array | null = null;
  if (xing && isLameTag(input, xing.offset + xing.headerLen)) {
    lameTag = input.slice(xing.offset + xing.headerLen, xing.offset + xing.headerLen + LAME_TAG_LEN);
  }
  const xingSkip = xing ? xing.headerLen + (lameTag ? LAME_TAG_LEN : 0) : 0;

  // --- Extract audio pool ---
  const poolLens: number[] = new Array(n);
  let poolLen = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 && xing && frames[i].mainDataBits > 0) {
      return fail("frame 0 has both Xing tag and audio data (unsupported)");
    }
    poolLens[i] = Math.ceil(frames[i].mainDataBits / 8);
    poolLen += poolLens[i];
  }
  const pool = new Uint8Array(poolLen);
  const Q: number[] = new Array(n);
  {
    let qp = 0;
    for (let i = 0; i < n; i++) {
      Q[i] = qp;
      const f = frames[i];
      // Xing-aware decoders skip the Xing/LAME tag; audio (if any) follows it.
      const sPos = i === 0 && xing ? xingSkip : C[i] - f.mainDataBegin;
      if (sPos < 0 || sPos + poolLens[i] > sLen) return fail(`frame ${i}: main data out of bounds`);
      copySRange(input, frames, C, sPos, sPos + poolLens[i], pool, qp);
      qp += poolLens[i];
    }
  }

  // --- Choose output frame sizes ---
  // We use a contiguous pool in the output S' at P[i] = poolStart + Q[i].
  // Then mdb'[i] = C'[i] - poolStart - Q[i] = (accumulated slack) - poolStart.
  // Constraint: 0 <= mdb'[i] <= maxMdb, i.e., accumulated slack in [poolStart, poolStart+maxMdb].
  // Forward pass: pick the smallest legal L'[i] keeping accumulated slack >= poolStart.
  // (Slack stays small, so the maxMdb upper bound is never hit.)
  //
  // If frame 0 has a Xing/Info tag, it is kept byte-identical (preserves the
  // tag layout exactly, avoiding demuxer/delay edge cases).
  // CRITICAL: Decoders do not add the Xing frame's area to the bit reservoir
  // (the Xing frame carries no audio and may be skipped). Therefore the pool
  // must start AFTER frame 0's entire area, and frame 1 (first audio frame)
  // must be self-contained (mdb=0). The reservoir builds from frame 1 onward.
  // If there is no Xing tag, frame 0 is repacked normally and the pool starts at 0.
  const keepFrame0 = xing !== null;
  const maxMdb = v0 === 1 ? 511 : 255; // MPEG-1: 9 bits, MPEG-2/2.5: 8 bits
  const frame0AreaEnd = frames[0].frameLength - H[0]; // Cp[1]
  const poolStart = keepFrame0 ? frame0AreaEnd : 0;
  const newLen: number[] = new Array(n);
  const newBrIdx: number[] = new Array(n);
  const newPad: boolean[] = new Array(n);
  let accSlack = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const h = H[i];
    if (i === 0 && keepFrame0) {
      // Keep frame 0 byte-identical. It still contributes its slack to the
      // reservoir accounting (though the pool starts after it).
      newLen[i] = f.frameLength;
      newBrIdx[i] = f.bitrateIndex;
      newPad[i] = f.padding;
      accSlack += newLen[i] - h - poolLens[i];
      continue;
    }
    const extra = 0;
    // Find smallest legal frame size with accSlack + (L - h - len_i) >= poolStart
    // and L >= h + extra.
    let picked: { brIdx: number; pad: boolean; len: number } | null = null;
    const table = bitrateTable(f);
    outer: for (let brIdx = 1; brIdx <= 14; brIdx++) {
      if (table[brIdx] === 0) continue;
      for (const pad of [false, true]) {
        const len = frameLengthFor(f, brIdx, pad);
        if (len < h + extra) continue;
        if (accSlack + (len - h - poolLens[i]) >= poolStart) {
          picked = { brIdx, pad, len };
          break outer;
        }
      }
    }
    if (!picked) return fail(`frame ${i}: no legal size satisfies reservoir constraints`);
    newLen[i] = picked.len;
    newBrIdx[i] = picked.brIdx;
    newPad[i] = picked.pad;
    accSlack += picked.len - h - poolLens[i];
  }
  const totalBytes = newLen.reduce((a, b) => a + b, 0);
  // (Xing header is left as-is in the byte-identical frame 0; stale
  // "bytes"/TOC fields do not affect audio decode. TODO: update in place.)

  // --- Compute output S' positions and mdb' ---
  const Cp: number[] = new Array(n);
  {
    let a2 = 0;
    for (let i = 0; i < n; i++) {
      Cp[i] = a2;
      a2 += newLen[i] - H[i];
    }
  }
  const mdbOut: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // P[i] = poolStart + Q[i] (contiguous pool)
    // For byte-identical frame 0 with Xing: mdb is irrelevant (0 audio bits); set to 0.
    if (i === 0 && keepFrame0) {
      mdbOut[0] = 0;
      continue;
    }
    const mdb = Cp[i] - poolStart - Q[i];
    if (mdb < 0 || mdb > maxMdb) return fail(`frame ${i}: mdb'=${mdb} out of range`);
    mdbOut[i] = mdb;
  }
  // Sanity: pool must fit in output S'
  const sLenOut = Cp[n - 1] + (newLen[n - 1] - H[n - 1]);
  if (poolStart + poolLen > sLenOut) return fail("pool does not fit in output");

  // --- Assemble output ---
  // Frame i's audio goes at S'[poolStart + Q[i]], which may lie in an earlier
  // frame's area (bit reservoir). Two passes: headers first, then audio.
  const out = new Uint8Array(totalBytes);
  const fileOff: number[] = new Array(n);
  let op = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    fileOff[i] = op;
    if (i === 0 && keepFrame0) {
      // Byte-identical copy of frame 0 (preserves Xing/Info + LAME/Lavc).
      out.set(input.subarray(f.offset, f.offset + f.frameLength), op);
      op += newLen[i];
      continue;
    }
    const origHdr = input.subarray(f.offset, f.offset + 4);
    out[op] = 0xff;
    out[op + 1] = 0xe0 | (versionBits(f) << 3) | (0b01 << 1) | (f.hasCrc ? 0 : 1);
    out[op + 2] = (newBrIdx[i] << 4) | (sampleRateIdx(f) << 2) | ((newPad[i] ? 1 : 0) << 1) | (origHdr[2] & 0x01);
    out[op + 3] = origHdr[3];
    let sp = op + 4;
    if (f.hasCrc) sp += 2; // CRC filled in below
    // side info: verbatim copy, then write new main_data_begin
    const siOff = f.offset + 4 + (f.hasCrc ? 2 : 0);
    out.set(input.subarray(siOff, siOff + f.sideInfoLen), sp);
    const mdb = mdbOut[i];
    if (v0 === 1) {
      out[sp] = (mdb >> 1) & 0xff;
      out[sp + 1] = (out[sp + 1] & 0x7f) | ((mdb & 1) << 7);
    } else {
      out[sp] = mdb & 0xff;
    }
    if (f.hasCrc) {
      const crc = mp3Crc16(out.subarray(op + 2, op + 4 + f.sideInfoLen), 0, 2 + f.sideInfoLen);
      out[op + 4] = (crc >> 8) & 0xff;
      out[op + 5] = crc & 0xff;
    }
    sp += f.sideInfoLen;
    // Note: audio bytes are placed in the second pass (may belong to earlier frames' areas).
    // Fill the whole area with zeros for now; audio overwrites.
    out.fill(0, sp, op + newLen[i]);
    op += newLen[i];
  }
  // Second pass: place audio pool bytes at their S' positions.
  const areaFileStart: number[] = new Array(n);
  for (let i = 0; i < n; i++) areaFileStart[i] = fileOff[i] + H[i];
  function sPrimeToFile(sPos: number): number {
    // binary search for frame j with Cp[j] <= sPos < Cp[j+1]
    let lo = 0,
      hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Cp[mid] <= sPos) lo = mid;
      else hi = mid - 1;
    }
    return areaFileStart[lo] + (sPos - Cp[lo]);
  }
  for (let i = 0; i < n; i++) {
    const sPos = poolStart + Q[i];
    const len = poolLens[i];
    let remaining = len;
    let sCur = sPos;
    let pCur = Q[i];
    while (remaining > 0) {
      const fPos = sPrimeToFile(sCur);
      // bytes until the end of this frame's area
      const j = (() => {
        let lo = 0,
          hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (Cp[mid] <= sCur) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      })();
      const areaEnd = areaFileStart[j] + (newLen[j] - H[j]);
      const chunk = Math.min(remaining, areaEnd - fPos);
      out.set(pool.subarray(pCur, pCur + chunk), fPos);
      remaining -= chunk;
      sCur += chunk;
      pCur += chunk;
    }
  }

  // Optional: preserve ID3v2 tag by prepending it to the output
  let finalOut = out;
  if (options.preserveId3v2 && s.id3v2Bytes > 0) {
    finalOut = new Uint8Array(s.id3v2Bytes + out.length);
    finalOut.set(input.subarray(0, s.id3v2Bytes), 0);
    finalOut.set(out, s.id3v2Bytes);
  }

  return {
    output: finalOut,
    inputBytes: input.length,
    outputBytes: finalOut.length,
    savedBytes: input.length - finalOut.length,
    passthrough: false,
  };
}
