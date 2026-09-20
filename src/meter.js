import { ACK_MESSAGES, ProtocolError, parseAck, parseId, parseQdda, parseQm } from './protocol.js';
import { TimeoutError } from './transport.js';

export class MeterError extends Error {
  constructor(command, code) {
    super(`${command}: ${ACK_MESSAGES[code] ?? `error ${code}`}`);
    this.code = code;
  }
}

// Request/response client. Commands are serialized: the meter handles one at a time.
export class Meter {
  #transport;
  #timeoutMs;
  #queue = Promise.resolve();

  constructor(transport, { timeoutMs = 2000 } = {}) {
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
  }

  #enqueue(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  // Sends `command`; returns the data line that follows the ACK (or null if none expected).
  command(command, { data = true } = {}) {
    return this.#enqueue(async () => {
      try {
        this.#transport.flush();
        await this.#transport.write(`${command}\r`);
        const ack = parseAck(await this.#transport.readLine(this.#timeoutMs));
        if (ack !== 0) throw new MeterError(command, ack);
        return data ? await this.#transport.readLine(this.#timeoutMs) : null;
      } catch (e) {
        if (e instanceof TimeoutError || e instanceof ProtocolError) this.#transport.flush();
        throw e;
      }
    });
  }

  async identify() {
    return parseId(await this.command('ID'));
  }

  async queryMeasurement() {
    return parseQm(await this.command('QM'));
  }

  async queryDisplay() {
    return parseQdda(await this.command('QDDA'));
  }

  close() {
    return this.#transport.close();
  }
}
