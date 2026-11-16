---
brand: Generic NTC thermistor module
buy: https://www.amazon.com/s?k=NTC+thermistor+module+10k
---
NTC thermistor module: a 10 kΩ NTC (β 3950) in a divider, the NTC from OUT to
GND and a fixed resistor from VCC to OUT. An NTC's resistance falls as it
warms, so OUT falls with temperature.

| Pin | Role |
| --- | --- |
| VCC | the board's 3.3 V or 5 V |
| OUT | analog output, to an ADC pin |
| GND | ground |

- R_ntc = R0 · e^(β (1/T − 1/298.15 K)), T in kelvin: R0 at 25 °C.
- OUT = VCC · R_ntc / (R_ntc + pull-up): half of VCC at 25 °C with the
  defaults.
- Set the temperature in the sensor panel; R0, β and the pull-up are the
  part's fields.

**Tip:** to read °C, turn the ADC count back into R_ntc =
pull-up · count / (full scale − count) and invert the β law:
1/T = 1/298.15 + ln(R_ntc / R0) / β.
