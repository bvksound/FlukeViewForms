// Transports move text between the app and a meter. All expose the same small interface:
//   write(text), readLine(timeoutMs), flush(), close()
// so the Meter class doesn't care whether it talks to Web Serial or the mock.

export class TimeoutError extends Error {}

// Splits an incoming character stream into lines (meter terminates with CR).
export class LineBuffer {
  #partial = '';
  #lines = [];
  #waiter = null;
  #error = null;

  push(text) {
    const parts = (this.#partial + text).split(/\r\n|\r|\n/);
    this.#partial = parts.pop();
    for (const p of parts) if (p) this.#lines.push(p);
    this.#waiter?.wake();
  }

  fail(error) {
    this.#error = error;
    this.#waiter?.wake();
  }

  clear() {
    this.#partial = '';
    this.#lines = [];
  }

  readLine(timeoutMs) {
    if (this.#lines.length) return Promise.resolve(this.#lines.shift());
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new TimeoutError(`No response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiter = {
        wake: () => {
          // A chunk can arrive without a complete line yet; keep waiting.
          if (!this.#lines.length && !this.#error) return;
          clearTimeout(timer);
          this.#waiter = null;
          if (this.#lines.length) resolve(this.#lines.shift());
          else reject(this.#error);
        },
      };
    });
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
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        this.#lines.push(decoder.decode(value, { stream: true }));
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
