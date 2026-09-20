// Transports move text between the app and a meter. All expose the same small interface:
//   write(text), readLine(timeoutMs), flush(), close()
// so the Meter class doesn't care whether it talks to Web Serial or the mock.

export class TimeoutError extends Error {}

const EOL = (b) => b === 0x0d || b === 0x0a;
const latin1 = new TextDecoder('latin1'); // the meter is byte-oriented; never treat replies as UTF-8

// Holds the bytes arriving from the meter. Text replies are read as CR-terminated lines; binary replies
// (which can contain CR bytes themselves) are read as one block. Commands are serialized, so one waiter at a time.
export class LineBuffer {
  #buf = new Uint8Array(0);
  #waiter = null;
  #error = null;

  push(data) {
    const bytes = typeof data === 'string' ? Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff) : data;
    const joined = new Uint8Array(this.#buf.length + bytes.length);
    joined.set(this.#buf);
    joined.set(bytes, this.#buf.length);
    this.#buf = joined;
    this.#waiter?.wake();
  }

  fail(error) {
    this.#error = error;
    this.#waiter?.wake();
  }

  clear() {
    this.#buf = new Uint8Array(0);
  }

  // Next non-empty line, or null when only a partial line is buffered.
  #takeLine() {
    for (;;) {
      const end = this.#buf.findIndex(EOL);
      if (end < 0) return null;
      const line = latin1.decode(this.#buf.subarray(0, end));
      this.#buf = this.#buf.subarray(end + 1);
      if (line) return line;
    }
  }

  // Resolves with test() as soon as it returns something other than null/false; rejects on timeout or link error.
  #until(test, timeoutMs) {
    const now = test();
    if (now != null && now !== false) return Promise.resolve(now);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new TimeoutError(`No response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiter = {
        wake: () => {
          // A chunk can arrive without a complete line yet; keep waiting unless the link failed.
          const value = test();
          if (value != null && value !== false) {
            clearTimeout(timer);
            this.#waiter = null;
            resolve(value);
          } else if (this.#error) {
            clearTimeout(timer);
            this.#waiter = null;
            reject(this.#error);
          }
        },
      };
    });
  }

  readLine(timeoutMs) {
    return this.#until(() => this.#takeLine(), timeoutMs);
  }

  // Everything the meter sends next, as bytes: waits for the first byte, then until the line has been quiet for
  // `settleMs`. The caller checks the framing and length, and retries if it is incomplete.
  async readBinary(timeoutMs, settleMs = 120) {
    await this.#until(() => this.#buf.length > 0, timeoutMs);
    let seen;
    do {
      seen = this.#buf.length;
      await new Promise((r) => setTimeout(r, settleMs));
    } while (this.#buf.length !== seen);
    const out = this.#buf;
    this.#buf = new Uint8Array(0);
    return out;
  }
}

export class WebSerialTransport {
  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // Ports this site was already granted (no popup needed). The last-used device comes first.
  static async grantedPorts() {
    const ports = await navigator.serial.getPorts();
    const last = WebSerialTransport.#lastUsed();
    const key = (p) => `${p.getInfo().usbVendorId}:${p.getInfo().usbProductId}`;
    return ports.sort((a, b) => (key(b) === last) - (key(a) === last));
  }

  // Reuses the remembered port when there is one; otherwise shows the browser's picker, which needs a click.
  // `choose: true` always shows the picker.
  static async request({ choose = false } = {}) {
    const port = (!choose && (await WebSerialTransport.grantedPorts())[0]) || (await navigator.serial.requestPort());
    const transport = new WebSerialTransport(port);
    await transport.open();
    WebSerialTransport.#remember(port);
    return transport;
  }

  static #lastUsed() {
    try {
      return localStorage.getItem('fluke287.lastPort');
    } catch {
      return null;
    }
  }

  static #remember(port) {
    const { usbVendorId, usbProductId } = port.getInfo();
    try {
      localStorage.setItem('fluke287.lastPort', `${usbVendorId}:${usbProductId}`);
    } catch {
      /* storage blocked: we just lose the preference */
    }
  }

  #port;
  #reader = null;
  #writer = null;
  #lines = new LineBuffer();

  constructor(port) {
    this.#port = port;
  }

  async open() {
    await this.#port.open({
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
    });
    this.#writer = this.#port.writable.getWriter();
    this.#reader = this.#port.readable.getReader();
    this.#pump();
  }

  async #pump() {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        this.#lines.push(value);
      }
    } catch (e) {
      this.#lines.fail(e); // e.g. cable unplugged
    }
  }

  get info() {
    return this.#port.getInfo();
  }

  write(text) {
    return this.#writer.write(new TextEncoder().encode(text));
  }

  readLine(timeoutMs) {
    return this.#lines.readLine(timeoutMs);
  }

  readBinary(timeoutMs, settleMs) {
    return this.#lines.readBinary(timeoutMs, settleMs);
  }

  flush() {
    this.#lines.clear();
  }

  async close() {
    try {
      await this.#reader?.cancel();
      this.#reader?.releaseLock();
      this.#writer?.releaseLock();
      await this.#port.close();
    } catch {
      /* port already gone */
    }
  }
}
