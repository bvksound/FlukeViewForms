# FlukeView Forms Open

Open-source, browser-based replacement for FlukeView Forms, starting with the **Fluke 287** and its IR serial port.
No install, no drivers beyond the USB-serial driver for the IR cable (FTDI on the Fluke IR189USB).

## Run it

```sh
npm start          # serves http://localhost:8000  (any static server works)
npm test           # protocol parser + mock-meter tests, no dependencies
```

Open the page in **Chrome, Edge or Opera** (macOS, Windows, Linux). Web Serial is not available in Firefox or Safari.
The page must be served from `https://` or `http://localhost`. Use **Demo meter** to try it without hardware.

## Status

| Feature | State |
|---|---|
| Live view (`ID`, `QM`, `QDDA`) | Working against the documented protocol; **untested on real hardware** |
| Record + CSV export | Working |
| Set / read settings | Only `DS`, `RI`, `RMP` are documented; the rest needs protocol capture |
| Read meter memory (saved measurements, logging sessions) | Not in the public spec; needs protocol capture |
| Form templates (logo, title, fields) | Planned: JSON templates in IndexedDB |
| PDF export | Planned: client-side (pdf-lib or jsPDF) |

## Protocol

115200 baud, 8N1, no flow control, commands terminated with CR, replies `ACK<CR>` then an optional data line.
See [docs/protocol.md](docs/protocol.md).

## Layout

```
index.html        UI
src/protocol.js   pure parsers (ID, QM, QDDA)
src/meter.js      request/response client with a command queue
src/transport.js  Web Serial transport + line buffer
src/mock.js       fake meter for development
src/format.js     LCD-style formatting
test/             node:test suites
```

No license is set yet; pick one before publishing.
