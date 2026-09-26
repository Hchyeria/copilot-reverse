import { appendFile } from "node:fs/promises";

export interface BatchOptions { debounceMs?: number; maxWaitMs?: number; maxBytes?: number }

// One outstanding append per file. Callers await append() at the stream boundary,
// so a slow disk cannot accumulate an unbounded queue of already-detached batches.
export class BatchWriter {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private failed = false;
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxBytes: number;

  constructor(private path: string, private onError: (error: unknown) => void,
    options: BatchOptions = {}, private write: typeof appendFile = appendFile) {
    this.debounceMs = options.debounceMs ?? 250;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
  }

  async append(chunk: Uint8Array): Promise<void> {
    // Await any timer-triggered append before admitting more bytes.
    if (this.writing) await this.writing;
    if (this.failed || this.closed || !chunk.byteLength) return;
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.byteLength;
    if (this.bytes >= this.maxBytes) { await this.flush(); return; }
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.flush(); }, this.debounceMs);
    this.idle.unref();
    if (!this.deadline) {
      this.deadline = setTimeout(() => { void this.flush(); }, this.maxWaitMs);
      this.deadline.unref();
    }
  }

  private clearTimers(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.deadline) clearTimeout(this.deadline);
    this.idle = this.deadline = undefined;
  }

  async flush(): Promise<void> {
    if (this.writing) await this.writing;
    this.clearTimers();
    if (this.failed || !this.bytes) return;
    const data = Buffer.concat(this.chunks, this.bytes);
    this.chunks = []; this.bytes = 0;
    const operation = (async () => {
      try { await this.write(this.path, data, { mode: 0o600 }); }
      catch (e) { this.failed = true; this.onError(e); }
    })();
    this.writing = operation;
    await operation;
    if (this.writing === operation) this.writing = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
