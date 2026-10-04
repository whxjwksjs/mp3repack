/** MSB-first bit reader over a Uint8Array. */
export class BitReader {
    buf;
    byte;
    bit; // 0..7 — index (from MSB) of next bit to read
    read; // total bits read
    constructor(buf, start = 0) {
        this.buf = buf;
        this.byte = start;
        this.bit = 0;
        this.read = 0;
    }
    readBits(n) {
        if (n < 0 || n > 32)
            throw new Error(`readBits(${n}) out of range`);
        let v = 0;
        while (n > 0) {
            if (this.byte >= this.buf.length)
                throw new Error("BitReader: past end of buffer");
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
    skip(n) {
        const total = this.bit + n;
        this.byte += Math.floor(total / 8);
        this.bit = total % 8;
        this.read += n;
        if (this.byte > this.buf.length)
            throw new Error("BitReader: skip past end of buffer");
    }
    /** Total bits consumed so far. */
    get bitsRead() {
        return this.read;
    }
    /** Byte offset of the current position (caller must be byte-aligned). */
    get bytePos() {
        if (this.bit !== 0)
            throw new Error("BitReader: bytePos queried mid-byte");
        return this.byte;
    }
}
//# sourceMappingURL=bits.js.map