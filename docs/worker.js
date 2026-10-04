import { repackMp3 } from './repack.js';

self.onmessage = async (e) => {
  const { id, buffer, preserveId3 } = e.data;
  try {
    const input = new Uint8Array(buffer);
    const result = repackMp3(input, { preserveId3v2: !!preserveId3 });
    // Transfer the output buffer back
    self.postMessage({
      id,
      ok: true,
      result: {
        output: result.output.buffer,
        inputBytes: result.inputBytes,
        outputBytes: result.outputBytes,
        savedBytes: result.savedBytes,
        passthrough: result.passthrough,
        reason: result.reason,
      },
    }, [result.output.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
