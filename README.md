# mp3repack

Lossless MP3 repacker in the spirit of WinMP3Packer: rearranges MP3 frame data to
produce a smaller valid MP3 — **without re-encoding**, so decoded audio is bit-identical
(verified via ffmpeg PCM MD5).

How it works: each MP3 frame at a given bitrate has a fixed size, and encoders
leave unused "stuffing" bytes inside frames that decoders ignore. mp3repack parses
every frame, extracts the real audio payload via the bit-reservoir model, and
re-emits each frame at the smallest legal frame size that fits — preserving the
reservoir with rewritten `main_data_begin` pointers, recomputing frame CRCs, and
keeping the Xing/Info + LAME/Lavc gapless tag bit-exact.

**Key insight:** decoders do NOT add the Xing frame's area to the bit reservoir
(the Xing frame carries no audio and may be skipped). So the audio pool starts
after frame 0, and the first audio frame is self-contained. This was validated
against minimp3's reservoir model and ffmpeg's decoder behavior.

Measured savings (6s test files, ffmpeg PCM MD5 verified identical):
| File | Saved |
|------|-------|
| CBR 320kbps | 4.35% (10.5 KB) |
| MPEG-2 64kbps | 4.51% (2.2 KB) |
| CBR 128kbps | 0.99% (958 B) |
| VBR V5 | 1.04% (530 B) |
| Mono 96kbps | 0.70% (513 B) |
| VBR V0 | 0.40% (462 B) |
| CBR 256kbps 48kHz | 0.07% (140 B) |

## Status

- [x] MP3 frame parser (MPEG-1/2/2.5 Layer III, reservoir pointers, CRC)
- [x] Repacker core (reservoir-preserving reframe, PCM-verified)
- [x] Verification (ffmpeg decode-compare across 7-file corpus)
- [x] Browser PWA (offline, drag-drop, Web Worker, ID3v2 preserve option)
- [x] Edge cases: free-format passthrough, MP3Pro passthrough, ID3v2 preservation, no-Xing, MPEG-2 255-byte reservoir limit, idempotence
- [ ] Repo handoff

## Layout

- `src/bits.ts` — bit reader
- `src/mp3.ts` — frame scanner + header/side-info parser
- `src/repack.ts` — the repacker
- `src/cli.ts` — `info`, `repack` commands
- `web/` — offline PWA (index.html, app.js, worker.js, sw.js, manifest.json)

## Usage

```bash
npm install
npx tsc
node dist/cli.js repack input.mp3 output.mp3
```

For the browser version, serve the `web/` directory over HTTP(S):
```bash
cd web && python3 -m http.server 8000
```
