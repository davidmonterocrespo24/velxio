import { runNetlist } from './SpiceEngine.js';

/**
 * Co-simulation bridge between avr8js (digital MCU) and ngspice (analog circuit).
 *
 * Workflow:
 *   1. Host runs the AVR for a slice of time (e.g. 1 ms of cycles).
 *   2. Host records the GPIO pin states (and PWM duties) at that instant.
 *   3. Host builds a PWL voltage source per AVR pin and a netlist for the circuit.
 *   4. ngspice runs a transient analysis covering that slice.
 *   5. Host reads the voltage at ADC-connected nodes and injects into avr8js.
 *   6. Repeat.
 *
 * This is quasi-static: the analog and digital clocks aren't locked cycle-to-cycle,
 * but the feedback loop refreshes at ~1 kHz which is enough for most educational
 * circuits (PWM filtering, sensors, LED drivers, etc.).
 */
export class AVRSpiceBridge {
  constructor(avr, { sliceMs = 1, analogChannels = [] } = {}) {
    this.avr = avr;
    this.sliceMs = sliceMs;
    this.analogChannels = analogChannels; // [{ channel, node }]
    this.analogPinVoltageHistory = new Map(); // pin → [{t, v}]
    this.adcSamples = [];
    this.t = 0;
  }

  /**
   * Run co-simulation for `totalMs` milliseconds.
   *
   * `buildNetlist(pinSnapshots, sliceStartMs, sliceEndMs)` must return a
   * complete ngspice netlist for the circuit. `pinSnapshots` is an object
   * mapping pin number → {type:'digital', v:0|5} or {type:'pwm', duty:0..1}.
   *
   * The bridge will patch in `.tran` automatically if not provided.
   */
  async run(totalMs, buildNetlist) {
    const slices = Math.ceil(totalMs / this.sliceMs);
    const cyclesPerSlice = Math.round(16_000_000 * (this.sliceMs / 1000));
    const timeline = [];

    for (let s = 0; s < slices; s++) {
      const t0 = s * this.sliceMs;
      const t1 = (s + 1) * this.sliceMs;
      // 1. Run the MCU
      this.avr.runCycles(cyclesPerSlice);
      // 2. Snapshot pin states
      const pinSnapshots = {};
      for (let p = 0; p <= 13; p++) {
        const duty = this.avr.getPWMDuty(p);
        if (duty !== null && duty > 0) {
          pinSnapshots[p] = { type: 'pwm', duty };
        } else {
          pinSnapshots[p] = { type: 'digital', v: this.avr.getPin(p) ? 5 : 0 };
        }
      }
      // 3. Build and run netlist
      const netlist = buildNetlist(pinSnapshots, t0, t1);
      const result = await runNetlist(netlist);
      // 4. Sample the voltages at the end of the slice on the configured ADC channels
      const time = result.vec('time');
      for (const { channel, node } of this.analogChannels) {
        const varname = `v(${node})`;
        let vec;
        try { vec = result.vec(varname); }
        catch { continue; }
        const vEnd = vec[vec.length - 1];
        this.avr.setAnalogVoltage(channel, vEnd);
        this.adcSamples.push({ t: t1 / 1000, channel, node, v: vEnd });
      }
      timeline.push({ t0, t1, pinSnapshots, result });
    }
    return timeline;
  }
}
