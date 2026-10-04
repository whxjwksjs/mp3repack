import { readFileSync, writeFileSync } from "node:fs";
import { parseMp3, stuffingEstimate } from "./mp3.js";
import { repackMp3 } from "./repack.js";

function cmdInfo(path: string): void {
  const data = readFileSync(path);
  const s = parseMp3(data);
  const f = s.frames;
  console.log(`file: ${path} (${data.length} bytes)`);
  console.log(`id3v2 skipped: ${s.id3v2Bytes} bytes, trailing: ${s.trailingBytes} bytes`);
  console.log(`frames: ${f.length}, duration: ${s.durationSec.toFixed(2)}s`);
  if (s.freeFormat) console.log(`FREE FORMAT detected`);
  if (s.xing) {
    const x = s.xing;
    console.log(
      `xing: ${x.isInfo ? "Info" : "Xing"} at +${x.offset - f[0].offset}, headerLen=${x.headerLen}, ` +
        `frames=${x.frames}, bytes=${x.bytes}, toc=${x.hasToc}, lame=${x.lameOffset >= 0 ? `yes len=${x.lameLen}` : "no"}`
    );
  }
  if (f.length === 0) {
    console.log("no frames found");
    return;
  }
  const f0 = f[0];
  console.log(
    `frame0: mpeg${f0.version} ${f0.bitrateKbps}kbps ${f0.sampleRate}Hz ch=${f0.channels} ` +
      `len=${f0.frameLength} si=${f0.sideInfoLen} crc=${f0.hasCrc} mainDataBegin=${f0.mainDataBegin} mainDataBits=${f0.mainDataBits}`
  );
  let badCrc = 0,
    unaligned = 0,
    minBits = Infinity,
    maxBits = 0;
  for (const fr of f) {
    if (fr.hasCrc && !fr.crcOk) badCrc++;
    if (fr.mainDataBits % 8 !== 0) unaligned++;
    minBits = Math.min(minBits, fr.mainDataBits);
    maxBits = Math.max(maxBits, fr.mainDataBits);
  }
  const est = stuffingEstimate(s);
  console.log(`crc mismatches: ${badCrc}, non-byte-aligned main data: ${unaligned}`);
  console.log(`mainDataBits range: ${minBits}..${maxBits}`);
  console.log(`stuffing estimate: ${est} bytes (${((100 * est) / data.length).toFixed(2)}%)`);
}

function cmdRepack(inPath: string, outPath: string, preserveId3: boolean): void {
  const data = readFileSync(inPath);
  const r = repackMp3(data, { preserveId3v2: preserveId3 });
  if (r.passthrough) {
    console.log(`passthrough: ${r.reason}`);
    // Still write the output (which is the original) so the file exists
    writeFileSync(outPath, r.output);
    return;
  }
  writeFileSync(outPath, r.output);
  console.log(
    `${inPath}: ${r.inputBytes} -> ${r.outputBytes} bytes ` +
      `(saved ${r.savedBytes}, ${((100 * r.savedBytes) / r.inputBytes).toFixed(2)}%) -> ${outPath}`
  );
}

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "info" && args[1]) cmdInfo(args[1]);
else if (cmd === "repack" && args[1] && args[2]) {
  const preserveId3 = args.includes("--preserve-id3");
  cmdRepack(args[1], args[2], preserveId3);
} else {
  console.error("usage: cli.js info <file.mp3> | cli.js repack <in.mp3> <out.mp3> [--preserve-id3]");
  process.exit(1);
}
