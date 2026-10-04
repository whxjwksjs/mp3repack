/** MSB-first bit reader over a Uint8Array. */
export class BitReader {
  private byte: number;
  private bit: number; // 0..7 — index (from MSB) of next bit to read
  private read: number; // total bits read

  constructor(private readonly buf: Uint8Array, start = 0) {
    this.byte = start;
    this.bit = 0;
    this.read = 0;
  }

  readBits(n: number): number {
    if (n < 0 || n > 32) throw new Error(`readBits(${n}) out of range`);
    let v = 0;
    while (n > 0) {
      if (this.byte >= this.buf.length) throw new Error("BitReader: past end of buffer");
      const avail = 8 - this.bit;
      const take = Math.min(avail, n);
      const shift = avail - take;
      v = (v << take) | ((this.buf[this.byte] >> shift) & ((1 << take) - 1));
      this.bit += take;
      if (this.bit === 8) {
        this.byte++;
        this.bit = 0;
      }
      n -= take;
      this.read += take;
    }
    return v >>> 0;
  }

  skip(n: number): void {
    const total = this.bit + n;
    this.byte += Math.floor(total / 8);
    this.bit = total % 8;
    this.read += n;
    if (this.byte > this.buf.length) throw new Error("BitReader: skip past end of buffer");
  }

  /** Total bits consumed so far. */
  get bitsRead(): number {
    return this.read;
  }

  /** Byte offset of the current position (caller must be byte-aligned). */
  get bytePos(): number {
    if (this.bit !== 0) throw new Error("BitReader: bytePos queried mid-byte");
    return this.byte;
  }
}
