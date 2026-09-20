// A fake 287 for developing and testing without hardware ("Demo meter" button).
import { LineBuffer } from '../src/transport.js';

export class MockTransport {
  #lines = new LineBuffer();
  props = { beeper: 'ON', digits: '5', ablto: '900', apoffto: '2100', dateFmt: 'DD_MM', timeFmt: '24', numFmt: 'POINT', tempOS: '0', aheventTh: '4', lang: 'ENGLISH', clock: '1789918816' };
  owner = { company: 'ACME', site: 'Lab', operator: 'Sam', contact: '123' };
  saveNames = ['Save', 'Site 1'];
  #t0 = Date.now();

  write(text) {
    const cmd = text.trim().toUpperCase();
    const reply = (...lines) => setTimeout(() => this.#lines.push(lines.join('\r') + '\r'), 15);
    if (cmd === 'ID') reply('0', 'FLUKE 287,V1.00,00000000');
    else if (/^QMP /.test(cmd)) {
      const key = this.#key(text.trim().split(/\s+/)[1]);
      reply(...(key ? ['0', this.props[key]] : ['1']));
    } else if (/^MP /.test(cmd)) {
      const [, name, value] = /^mp\s+(\w+),(.*)$/i.exec(text.trim()) ?? [];
      const key = this.#key(name);
      if (key && key !== 'lang') this.props[key] = value.trim();
      reply(key && key !== 'lang' ? '0' : '2');
    } else if (/^QMPQ /.test(cmd)) {
      const key = text.trim().split(/\s+/)[1].toLowerCase();
      reply(...(key in this.owner ? ['0', `'${this.owner[key]}'`] : ['1']));
    } else if (/^MPQ /.test(cmd)) {
      const [, name, value] = /^mpq\s+(\w+),'(.*)'$/i.exec(text.trim()) ?? [];
      if (name?.toLowerCase() in this.owner) this.owner[name.toLowerCase()] = value;
      reply(name?.toLowerCase() in this.owner ? '0' : '1');
    } else if (/^QSAVNAME /.test(cmd)) {
      const name = this.saveNames[Number(cmd.split(' ')[1])];
      reply(...(name ? ['0', name] : ['5']));
    } else if (/^SAVNAME /.test(cmd)) {
      const [, i, name] = /^savname\s+(\d+),"(.*)"$/i.exec(text.trim()) ?? [];
      if (i !== undefined) this.saveNames[Number(i)] = name;
      reply(i !== undefined ? '0' : '1');
    } else if (cmd === 'QBL') reply('0', 'PARTLY_EMPTY_2');
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

  #key(name) {
    return Object.keys(this.props).find((k) => k.toLowerCase() === String(name).toLowerCase());
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
