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
| `QCVN` | `V0.14` | A version string, not the `ID` firmware version. Purpose unknown |
| `QCCV` | `4` | Unknown, possibly a version or revision |
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

`QMAP primfunction` returned a syntax error on our meter, so the map name or form is different.

### Setting values (verified on our meter)

Writes were verified by writing each setting back to its current value (ACK `0`, value unchanged).

| Command | Effect |
|---|---|
| `MP <name>,<value>` | Sets a meter property, bare value as read back by `QMP`: `MP beeper,ON`, `MP ablto,900` |
| `MPQ <field>,'<text>'` | Sets an owner field, text in single quotes |
| `SAVNAME <n>,"<name>"` | Sets a save-slot name, name in double quotes |
| `MP clock,<seconds>` | Sets the clock (not written during verification) |

The meter keeps local wall-clock time encoded as if it were UTC: at 15:40 in CEST, `QMP clock` returned the value for
15:40 UTC. Send `epoch - getTimezoneOffset() * 60` from a browser. `lang` cannot be set (error 2), and the list of
accepted values for the other choices (`MM_DD`, `12`, `COMMA`, `OFF`…) is inferred, not confirmed.

### Reported by the open-source tools, not yet verified on our meter

| Command | Reported meaning |
|---|---|
| `QRSI <n>` | Recording session n: binary header, readings, name |
| `QSRR <reading>,<sample>` | One sample of a recording (146-byte binary record) |
| `QMMSI <n>` | Min/max session n |
| `QPSI <n>` | Peak session n |
| `QSMR <n>` | Saved measurement n |
| `QMAP <name>` | Value map (count and key/value pairs) |
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

## Still unknown

Starting and stopping a recording session on the meter, and the exact binary layouts (checksums, block framing). Plan:
verify the reported memory commands on a meter that has stored data, then decode the binary records against the tools above.
