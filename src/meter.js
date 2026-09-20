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

  // Battery level as the meter words it, e.g. "PARTLY_EMPTY_2". Undocumented; found by scanning a 287 (V1.16).
  async queryBattery() {
    return (await this.command('QBL')).trim();
  }

  // Documented setup commands (see docs/protocol.md). None of them return data.
  defaultSetup() {
    return this.command('DS', { data: false });
  }

  resetInstrument() {
    return this.command('RI', { data: false });
  }

  resetMeterProperties() {
    return this.command('RMP', { data: false });
  }

  // Sends any command and returns every line the meter answers with, ACK included. For exploring
  // undocumented commands; stops once the meter has been quiet for `settleMs`.
  raw(command, { timeoutMs = this.#timeoutMs, settleMs = 300 } = {}) {
    return this.#enqueue(async () => {
      this.#transport.flush();
      await this.#transport.write(`${command}\r`);
      const lines = [];
      try {
        lines.push(await this.#transport.readLine(timeoutMs));
        for (;;) lines.push(await this.#transport.readLine(settleMs));
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
      }
      return lines;
    });
  }

  close() {
    return this.#transport.close();
  }
}
