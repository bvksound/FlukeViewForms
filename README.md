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

The ready-to-upload page is [`dist/Fluke287.html`](dist/Fluke287.html): one self-contained file with all modules and
the Fluke logo inlined. Put it next to your site's `site-nav.js` and `images/logo.png` (header, logo, menu). It is
committed, so rebuild it after changing anything in `src/` or `index.html`:

```sh
node scripts/build.mjs                     # regenerates dist/Fluke287.html
scripts/sync-website.sh /path/to/website   # optional: builds and copies it into a local website folder
```

## Status

| Feature | State |
|---|---|
| Live view (`ID`, `QM`, `QDDA`) | Working on a real 287 (firmware V1.16) |
| Scrollable live graph, Y-axis auto/manual/zoom/pan | Working (tested against a fake serial port; verify on the meter) |
| Remembered port, auto-connect | Working |
| Battery level (four-bar icon) | Working |
| Meter settings panel (clock sync, beeper, digits, timeouts, formats, owner fields, save slots) | Working; write syntax verified on a real 287 |
| Advanced: default setup, resets, raw command box | Working; resets not yet run on a real meter |
| Record + CSV export | Working |
| Read meter memory (saved measurements, recordings) | Commands known from open-source tools (see docs/protocol.md), not built yet |
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
src/settings.js   settings definitions and clock helpers
src/settings-ui.js the Meter settings panel
src/graph.js      scrollable live graph
test/             node:test suites (mock-meter.js is a fake 287 used by the tests)
scripts/          dev-server.mjs (serves site header/logo from the website folder), build.mjs, sync-website.sh
images/           Fluke logo
```

## License

[MIT](LICENSE) for the code. Not affiliated with or endorsed by Fluke Corporation. "Fluke" and "FlukeView" are trademarks of their owners;
`images/fluke-seeklogo.svg` is the Fluke logo, used only to identify the supported meter, and is not covered by the MIT license.
