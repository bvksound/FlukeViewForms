// A fake 287 for developing and testing without hardware ("Demo meter" button).
import { LineBuffer } from './transport.js';

export class MockTransport {
  #lines = new LineBuffer();
  #t0 = Date.now();

  write(text) {
    const cmd = text.trim().toUpperCase();
    const reply = (...lines) => setTimeout(() => this.#lines.push(lines.join('\r') + '\r'), 15);
    if (cmd === 'ID') reply('0', 'FLUKE 287,V1.00,00000000');
    else if (cmd === 'QM') {
      const v = this.#value();
      reply('0', `${v.toExponential(4).toUpperCase()},VDC,NORMAL,NONE`);
    } else if (cmd === 'QDDA') {
      const v = this.#value();
      const ts = (Date.now() / 1000).toFixed(3);
      const reading = (id) => `${id},${v.toFixed(4)},VDC,0,4,5,NORMAL,NONE,${ts}`;
      reply('0', `V_DC,NONE,AUTO,VDC,10,0,OFF,0.000,0,2,${reading('LIVE')},${reading('PRIMARY')}`);
    } else reply('1');
    return Promise.resolve();
  }

  #value() {
    const s = (Date.now() - this.#t0) / 1000;
    return 5 + 2 * Math.sin(s / 2) + 0.05 * (Math.random() - 0.5);
  }

  readLine(timeoutMs) {
    return this.#lines.readLine(timeoutMs);
  }

  flush() {
    this.#lines.clear();
  }

  async close() {}
}
