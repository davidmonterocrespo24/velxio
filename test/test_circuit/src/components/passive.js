// Passive linear components: Resistor, VoltageSource, CurrentSource, Capacitor.
// Each component exposes:
//   name, nodes() → [a, b, ...], stampDC(G, b, ctx)
//   flags: isVoltageSource, isNonlinear

export class Resistor {
  constructor(name, a, b, resistance) {
    this.name = name;
    this.a = a;
    this.b = b;
    this.R = resistance;
  }
  nodes() { return [this.a, this.b]; }
  stampDC(G, b, ctx) {
    const g = 1 / this.R;
    const ia = ctx.nodeIndex(this.a);
    const ib = ctx.nodeIndex(this.b);
    if (ia >= 0) G[ia][ia] += g;
    if (ib >= 0) G[ib][ib] += g;
    if (ia >= 0 && ib >= 0) { G[ia][ib] -= g; G[ib][ia] -= g; }
  }
}

export class VoltageSource {
  constructor(name, plus, minus, voltage) {
    this.name = name;
    this.plus = plus;
    this.minus = minus;
    this.V = voltage;
    this.isVoltageSource = true;
  }
  nodes() { return [this.plus, this.minus]; }
  setVoltage(v) { this.V = v; }
  stampDC(G, b, ctx) {
    const ip = ctx.nodeIndex(this.plus);
    const im = ctx.nodeIndex(this.minus);
    const iv = ctx.vsourceIndex(this.name);
    if (ip >= 0) { G[ip][iv] += 1; G[iv][ip] += 1; }
    if (im >= 0) { G[im][iv] -= 1; G[iv][im] -= 1; }
    b[iv] += this.V;
  }
}

export class CurrentSource {
  constructor(name, from, to, current) {
    this.name = name;
    this.from = from;   // current flows from → to inside the source (into 'to')
    this.to = to;
    this.I = current;
  }
  nodes() { return [this.from, this.to]; }
  stampDC(G, b, ctx) {
    const ifrom = ctx.nodeIndex(this.from);
    const ito = ctx.nodeIndex(this.to);
    if (ifrom >= 0) b[ifrom] -= this.I;
    if (ito >= 0) b[ito] += this.I;
  }
}

/**
 * Capacitor (backward Euler companion model).
 *   G_eq = C / dt
 *   I_eq = (C / dt) * V_prev
 * Stamped as a conductance + current source between a and b.
 */
export class Capacitor {
  constructor(name, a, b, capacitance, initialV = 0) {
    this.name = name;
    this.a = a;
    this.b = b;
    this.C = capacitance;
    this.Vinit = initialV;
  }
  nodes() { return [this.a, this.b]; }
  stampDC(G, b, ctx) {
    const ia = ctx.nodeIndex(this.a);
    const ib = ctx.nodeIndex(this.b);
    const dt = ctx.dt;
    if (!dt) {
      // Pure DC: treat as open circuit (very large R to keep matrix non-singular)
      const g = 1e-12;
      if (ia >= 0) G[ia][ia] += g;
      if (ib >= 0) G[ib][ib] += g;
      if (ia >= 0 && ib >= 0) { G[ia][ib] -= g; G[ib][ia] -= g; }
      return;
    }
    const g = this.C / dt;
    const Vprev = ctx.prev
      ? ((ctx.prev.nodeVoltages[this.a] ?? 0) - (ctx.prev.nodeVoltages[this.b] ?? 0))
      : this.Vinit;
    const Ieq = g * Vprev;
    if (ia >= 0) G[ia][ia] += g;
    if (ib >= 0) G[ib][ib] += g;
    if (ia >= 0 && ib >= 0) { G[ia][ib] -= g; G[ib][ia] -= g; }
    if (ia >= 0) b[ia] += Ieq;
    if (ib >= 0) b[ib] -= Ieq;
  }
}

/** Potentiometer: two resistors in series with a middle wiper node. */
export class Potentiometer {
  constructor(name, top, wiper, bottom, totalR, wiperPos = 0.5) {
    this.name = name;
    this.top = top;
    this.wiper = wiper;
    this.bottom = bottom;
    this.totalR = totalR;
    this.wiperPos = wiperPos;   // 0..1, 0 = wiper at bottom, 1 = wiper at top
  }
  nodes() { return [this.top, this.wiper, this.bottom]; }
  setWiper(pos) { this.wiperPos = Math.max(0, Math.min(1, pos)); }
  stampDC(G, b, ctx) {
    const minR = 1;  // avoid 0Ω
    const Rtop = Math.max(minR, (1 - this.wiperPos) * this.totalR);
    const Rbot = Math.max(minR, this.wiperPos * this.totalR);
    new Resistor(this.name + '_top', this.top, this.wiper, Rtop).stampDC(G, b, ctx);
    new Resistor(this.name + '_bot', this.wiper, this.bottom, Rbot).stampDC(G, b, ctx);
  }
}

/** NTC thermistor. R(T) = R0 · exp(β · (1/T − 1/T0)), T in Kelvin. */
export class NTCThermistor {
  constructor(name, a, b, { R0 = 10000, T0 = 298.15, beta = 3950 } = {}) {
    this.name = name;
    this.a = a;
    this.b = b;
    this.R0 = R0;
    this.T0 = T0;
    this.beta = beta;
    this.TCelsius = 25;
  }
  nodes() { return [this.a, this.b]; }
  setTemperatureC(c) { this.TCelsius = c; }
  resistance() {
    const T = this.TCelsius + 273.15;
    return this.R0 * Math.exp(this.beta * (1 / T - 1 / this.T0));
  }
  stampDC(G, b, ctx) {
    new Resistor(this.name + '_R', this.a, this.b, this.resistance()).stampDC(G, b, ctx);
  }
}

/** Simple switch: R=0.001 closed, R=1e9 open. */
export class Switch {
  constructor(name, a, b, closed = false) {
    this.name = name;
    this.a = a;
    this.b = b;
    this.closed = closed;
  }
  nodes() { return [this.a, this.b]; }
  set(state) { this.closed = state; }
  stampDC(G, b, ctx) {
    const R = this.closed ? 1e-3 : 1e9;
    new Resistor(this.name + '_R', this.a, this.b, R).stampDC(G, b, ctx);
  }
}
