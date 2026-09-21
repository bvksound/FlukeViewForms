# Fluke 287/289 remote interface

Source: *Fluke 289/287 Remote Interface Specification*, Technical Note, © 2007 Fluke Corporation
(e.g. <https://btbm.ch/assets/uploads/Fluke28xRemoteInterfaceSpecifications.pdf>).
Fluke states it will not support the document.

## Link

- IR optical port, 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control.
- The IR cable needs no special handling of modem control lines; it behaves like a plain serial cable.
- Commands are 2+ letters, upper or lower case, terminated by `<CR>`. The meter does no line editing and does not echo.

## Acknowledge

Every command is answered with a single digit and `<CR>`: `0` OK, `1` syntax error, `2` execution error, `5` no data.
Unlike the 189, the 289/287 does not prefix the command name.

## Documented commands

| Command | Response |
|---|---|
| `ID` | `ACK` then `FLUKE 287,V1.00,<serial>` |
| `QM` | `ACK` then `value,unit,state,attribute` (base units, e.g. `0.5498E0,VDC,NORMAL,GOOD_DIODE`) |
| `QDDA` | `ACK` then one long line, see below |
| `DS` | default setup (Hz trigger edge, pulse polarity, continuity beeper) |
| `RI` | reset instrument to factory settings (keeps calibration) |
| `RMP` | reset meter properties (front panel *Reset Setup*) |

Overload/invalid readings are returned as `9.99999999E+37`.

### QDDA layout

```
primaryFunction, secondaryFunction, autoRangeState, baseUnit, rangeNumber, unitMultiplier,
lightningBolt, minMaxStartTime, numberOfModes, mode * N, numberOfReadings, reading * M
reading = readingID, value, baseUnit, unitMultiplier, decimalPlaces, displayDigits, state, attribute, timeStamp
```

Timestamps are Unix seconds (float) from the meter's clock. `unitMultiplier` is the power of ten of the displayed prefix
(-9 n, -6 µ, -3 m, 0, 3 k, 6 M). Reading IDs: LIVE, PRIMARY, SECONDARY, REL_LIVE, BARGRAPH, MINIMUM, MAXIMUM, AVERAGE,
REL_REFERENCE, DB_REF, TEMP_OFFSET.

## Undocumented commands (unofficial)

Not in Fluke's spec. Two sources: an exhaustive scan of a real Fluke 287 (firmware V1.16) with every `Q` + 1 to 3 letter
command (18,277 probes, only `Q` commands were sent), and the open-source projects credited at the bottom.
"Verified" means it answered on our meter. Meanings are inferred from names and replies unless a source says otherwise.

### Verified on our meter (read-only queries)

| Command | Reply seen | Meaning |
|---|---|---|
| `QBL` | `PARTLY_EMPTY_2` | Battery level in the meter's own words (used by the page). Other values not yet seen |
| `QMF` | `MV_AC,NONE` | Current primary and secondary function |
| `QMR` | `50,-3` | Current range number and unit multiplier |
| `QMM` | `0` | Active modes (none) |
| `QSN` | `14560135` | Serial number |
| `QCVN` | `V0.14` | **Calibration version**: confirmed, the Meter Info screen shows "calibration version 0.14" (read-only; used by the app) |
| `QCCV` | `4` | **Calibration counter**: confirmed, the meter's Meter Info screen also showed 4 (read-only; used by the app) |
| `QDDB` | binary | Binary form of `QDDA` |
| `QSLS` | `0,0,0,0` | Storage summary: number of recordings, min/max, peak and saved measurements (all empty here) |
| `QSUS` | `DISABLED` | Unknown |
| `QMP <name>` | see below | Read a meter property |
| `QMPQ <name>` | `'text'` | Read an owner field: `company`, `site`, `operator`, `contact` (value in single quotes) |
| `QSAVNAME <n>` | `Save` | Name of save slot n (0-based) |

`QMP` properties and the values seen: `clock` (Unix seconds, `1789918816`), `lang` (`ENGLISH`), `dateFmt` (`DD_MM`),
`timeFmt` (`24`), `digits` (`5`), `beeper` (`ON`), `tempOS` (`0`, temperature offset), `numFmt` (`POINT`),
`ablto` (`900`, auto backlight timeout, seconds), `apoffto` (`2100`, auto power-off timeout, seconds),
`aheventTh` (`4`, AutoHold event threshold). Other names seen in the projects below: smoothing, DBM reference,
recording threshold, save-slot names.

`QMAP primfunction` returned a syntax error on our meter: the value-map command is `QEMAP`, not `QMAP`.

### Setting values (verified on our meter)

Writes were verified by writing each setting back to its current value (ACK `0`, value unchanged).

| Command | Effect |
|---|---|
| `MP <name>,<value>` | Sets a meter property, bare value as read back by `QMP`: `MP beeper,ON`, `MP ablto,900` |
| `MPQ <field>,'<text>'` | Sets an owner field, text in single quotes |
| `SAVNAME <n>,"<name>"` | Sets a save-slot name, name in double quotes |
| `MP clock,<seconds>` | Sets the clock (not written during verification) |

The meter keeps local wall-clock time encoded as if it were UTC: at 15:40 in CEST, `QMP clock` returned the value for
15:40 UTC. Send `epoch - getTimezoneOffset() * 60` from a browser. Setting `lang` was not tried on our meter. The
accepted values for the other choices (`MM_DD`, `12`, `COMMA`, `OFF`…) are inferred or taken from f289ctrl, not confirmed
here.

### More properties (from f289ctrl, Rust, MIT; read and written back unchanged on our meter)

Each of these read correctly on our 287 and accepted a write of its own current value (ACK `0`, value unchanged):
`lang` (`ENGLISH`), `acsmooth` (`OFF`), `dBmRef` (`600`), `cusDBm` (`600`), `recEventTh` (`4`). Values a setting accepts other
than its current one are the ones f289ctrl lists:

| Command | Values reported |
|---|---|
| `MP lang,<name>` | `GERMAN`, `ENGLISH`, `FRENCH`, `ITALIAN`, `SPANISH`, `JAPANESE`, `CHINESE` |
| `QMP` / `MP acsmooth,ON\|OFF` | AC smoothing |
| `QMP` / `MP dBmRef,<n>` | dBm reference impedance: `4`, `8`, `16`, `25`, `32`, `50`, `75`, `600`, `1000` or `CUSTOM` |
| `QMP` / `MP cusDBm,<n>` | Custom dBm reference |
| `QMP` / `MP recEventTh,<n>` | Recording event threshold |
| `CSD <kind>` | **Erases** stored data. Kinds: `MEASUREMENT`, `MIN_MAX`, `RECORDED` (peak and all also exist). Destructive: never send without an explicit, confirmed user action |

### Reported by the open-source tools, not yet verified on our meter

| Command | Reported meaning |
|---|---|
| `QEMAP <name>` | Value map: `count,key,value,key,value…` (numeric id → name); see Binary memory records |
| `QRSI <n>` | Recording session n: binary header, readings, name |
| `QSRR <reading>,<sample>` | One sample of a recording (146-byte binary record) |
| `QMMSI <n>` | Min/max session n |
| `QPSI <n>` | Peak session n |
| `QSMR <n>` | Saved measurement n |
| memory clear | Erases a memory section. Destructive: never send without an explicit user action |

Binary replies start with the ACK then `#0` and a little-endian structure: 30 bytes per reading (id, 8-byte double
value, unit, multiplier, decimals, state, timestamp). Each of these commands needs an argument, which is why a
no-argument scan cannot find them.

The scan found no command that changes the meter's function, range or mode. One user of the interface reports
that "a serial port cannot turn the knob" (btbm.ch); the properties above are the only settings the projects change.

## Sources

- N0ury/dmm_util (Python, MIT): https://github.com/N0ury/dmm_util
- fvaleur/dmm_util (Ruby original): https://github.com/fvaleur/dmm_util
- cytrinox/f289ctrl (Rust, MIT): https://github.com/cytrinox/f289ctrl
- Fluke 289/287 Remote Interface Specification (2007), see top of this file

## Binary memory records

Layouts from the open-source tools (N0ury/dmm_util, MIT). Checked on a real 287 (V1.16) for `QDDB`, `QEMAP`, `QSLS`,
`QRSI` (a stored recording, name and times decoded correctly) and `QSRR` (its samples). `QSMR`, `QMMSI` and `QPSI` are
still untested on real data because the meter held no saved measurements or min/max/peak sessions; their decoders are
tested against the layout only.

**Framing.** A binary reply is `0`, CR, `#0`, payload, CR. The payload can itself contain CR bytes, so it cannot be read
as a line: read until the meter has been quiet for about 100 ms, check the framing, and re-request the command when
the length does not match. Numbers are little-endian. A 64-bit double is two little-endian 32-bit words, **high word
first**. Fields such as function, unit and state are numeric ids; `QEMAP <name>` translates them. Names used:
`readingid`, `unit`, `state`, `attribute`, `primfunction`, `secfunction`, `autorange`, `bolt`, `mode`, `recordtype`,
`isstableflag`, `transientstate`.

**Reading** (30 bytes): id u16, value f64, unit u16, multiplier s16, decimals s16, display digits s16, state u16,
attribute u16, time f64 (seconds, meter's local wall-clock time as if UTC).

| Command | Payload |
|---|---|
| `QDDB` | 34-byte header (primary function @0, secondary @2, auto range @4, unit @6, range max f64 @8, multiplier @16, bolt @18, mode @28, reading count @32) then the readings. Verified on our meter |
| `QSMR n` | 38-byte header (seq @0, functions @4/@6, range @8, unit @10, range max @12, multiplier @20, bolt @22, mode @32, reading count @36), readings, then the name |
| `QMMSI n`, `QPSI n` | 54-byte header (seq @0, start f64 @4, end f64 @12, functions @20/@22, range @24, unit @26, range max @28, multiplier @36, bolt @38, mode @48, reading count @52), readings, name |
| `QRSI n` | 78-byte header (start @4, end @12, sample interval f64 @20, event threshold f64 @28, reading index @36, sample count @40, functions @44/@46, range @48, unit @50, range max @52, multiplier @60, bolt @62, mode @72, reading count @76), readings, name |
| `QSRR r,s` | Exactly 146 bytes: start f64 @0, end f64 @8, three readings @16 (max, average, min), reading count u16 @106, primary reading @110, record type @140, stable flag @142, transient state @144. `r` is the recording's reading index, `s` the 0-based sample. **The stored average is the sum of the interval's readings: divide by the count @106** (checked on a real recording: sums exceeded the interval maximum until divided) |

## Shown on the meter's Meter Info screen, not yet found as commands

The 287's Meter Info screen (Setup) shows: serial number, model, firmware `1.16 / V0.88`, calibration date, calibration
counter `4`, and board id `3` (values from our meter). `ID`, `QSN`, `QCCV` and `QCVN` cover the serial number, firmware 1.16,
the calibration counter and the calibration version (0.14). The screen also lists an ARM bootloader (2.0.74). Still
unmatched: the second firmware version (V0.88), the ARM bootloader version, the board id (3) and the calibration date. The `Q`
scan (up to three letters after Q) did not turn them up, so they use longer names or are `QMP` properties.

## Still unknown

Starting and stopping a recording session on the meter. The memory commands still need a check against a meter that
holds stored data (press Save on the meter, or record a session).
