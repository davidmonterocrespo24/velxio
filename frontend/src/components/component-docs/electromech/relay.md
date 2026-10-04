---
brand: Generic SPDT relay (Songle SRD-05VDC-SL-C class)
buy: https://www.amazon.com/s?k=5v+spdt+relay+module
---
Electromechanical SPDT relay. Energising the coil pulls the common contact
from the normally-closed terminal over to the normally-open one. Drive the
coil through a transistor: a 5 V / 70 Ω coil draws 71 mA, more than an MCU
pin can source.

| Pin | Role |
| --- | --- |
| COIL+ / COIL- | the coil; polarity only matters for the flyback diode |
| COM | moving contact |
| NO | normally open: joined to COM while the coil is energised |
| NC | normally closed: joined to COM while the coil is idle |

- **Pull-in and drop-out** are fractions of `coil_voltage`: the contacts
  close once the coil sees **75%** of it (3.75 V on a 5 V coil) and, within a
  time-domain run, open again below **45%** (2.25 V). A 3.3 V pin on a 5 V
  coil never reaches 3.75 V, so it never pulls in: use a 3.3 V coil, or feed
  the coil from 5 V through a transistor.
- **`coil_resistance` sets the coil current**, exactly as on a datasheet:
  I = coil voltage / R (5 V / 70 Ω = 71 mA, the usual SRD-05VDC part). It does
  not move the pull-in point; `coil_voltage` does.
- Fed straight from a 5 V rail, a 5 V coil sees 5 V whatever its resistance,
  so the contacts cannot tell 70 Ω from 5 GΩ: only the current drawn changes.
  To see it, put an **Ammeter** in series with the coil, or feed the coil
  through something with resistance of its own (a series resistor, a
  transistor, a divider). Then V_coil = V_src x R / (R + R_src), and a
  high-resistance coil pulls in where a low-resistance one stays open: through
  1 kΩ from 5 V, a 70 Ω coil keeps 0.33 V and a 5 GΩ coil keeps 5 V.
- `include_flyback` puts a 1N4148 across the coil (cathode on COIL+) to absorb
  the turn-off spike.

**Tip:** `pin -> 1 kΩ -> 2N2222 base`, `emitter -> GND`, `collector -> COIL-`,
`COIL+ -> 5V`. The Relay-Controlled LED example wires exactly this.
