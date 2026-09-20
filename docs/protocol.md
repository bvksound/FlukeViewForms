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

## Found by scanning a real meter (unofficial)

Observed on a Fluke 287, firmware V1.16, by sending `Q` + 1 to 3 letters and logging every reply that was not a
syntax error (`1`). These are not in Fluke's spec; meanings are inferred from names and replies unless noted.

| Command | Reply seen | Meaning |
|---|---|---|
| `QBL` | `PARTLY_EMPTY_2` | Battery level, in the meter's own words (used by the page). Other values not yet seen. |
| `QMF` | `MV_AC,NONE` | Current primary and secondary function |
| `QMR` | `50,-3` | Current range number and unit multiplier |
| `QMM` | `0` | Active modes (none) |
| `QSN` | `14560135` | Serial number |
| `QCVN` | `V0.14` | A version string, not the `ID` firmware version. Purpose unknown |
| `QCCV` | `4` | Unknown, possibly a version or revision |
| `QDDB` | binary | Binary form of `QDDA` (display data) |

The scan covered only `Q???` and shorter, so longer names and non-`Q` commands (set commands, memory, recording)
are still unknown. Commands that change the meter were deliberately never sent.

## Not documented (needs capture from the official FlukeView Forms)

Reading and writing meter settings, saved measurements, min/max/average recordings, logging sessions, and setting the
meter clock. FlukeView Forms clearly supports these, so the commands exist. Plan: run the official software on Windows
with a serial port monitor between it and the IR cable, record the traffic, and document each command here with captured
samples before implementing it.
