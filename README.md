# FlukeView Forms Open

Open-source, browser-based replacement for FlukeView Forms, starting with the **Fluke 287** and its IR serial port.
No install, no drivers beyond the USB-serial driver for the IR cable (FTDI on the Fluke IR189USB).

## Run it

```sh
npm start          # serves http://localhost:8000  (any static server works)
npm test           # protocol parser + mock-meter tests, no dependencies
```

Open the page in **Chrome, Edge or Opera** (macOS, Windows, Linux). Web Serial is not available in Firefox or Safari.
The page must be served from `https://` or `http://localhost`.

To publish inside a BVKsound-style website (shared header, logo, Tools menu), run
`scripts/sync-website.sh /path/to/website`. It copies the page as `Fluke287.html` plus `fluke287/src/`.

## Status

| Feature | State |
|---|---|
| Live view (`ID`, `QM`, `QDDA`) | Working on a real 287 (firmware V1.16) |
| Scrollable live graph, Y-axis auto/manual/zoom/pan | Working (tested against a fake serial port; verify on the meter) |
| Remembered port, auto-connect | Working |
| Advanced: default setup, resets, raw command box | Working; resets not yet run on a real meter |
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
src/format.js     LCD-style formatting
test/             node:test suites (mock-meter.js is a fake 287 used by the tests)
scripts/          dev-server.mjs (serves site header/logo from the website folder), sync-website.sh
images/           Fluke logo
```

## License

[MIT](LICENSE) for the code. Not affiliated with or endorsed by Fluke Corporation. "Fluke" and "FlukeView" are trademarks of their owners;
`images/fluke-seeklogo.svg` is the Fluke logo, used only to identify the supported meter, and is not covered by the MIT license.
