import { Vt } from '../solver/Circuit.js';

/**
 * Shockley diode (and LED).
 *   I_d = Is · (exp(V_d / (n·Vt)) − 1)
 * Linearized each Newton iteration:
 *   g_d = (Is/(n·Vt)) · exp(V_d_prev/(n·Vt))
 *   Ieq = Id(V_d_prev) − g_d · V_d_prev
 */
export class Diode {
  constructor(name, anode, cathode, { Is = 1e-14, n = 1.0, Vclamp = 40 } = {}) {
    this.name = name;
    this.anode = anode;
    this.cathode = cathode;
    this.Is = Is;
    this.n = n;
    this.Vclamp = Vclamp;
    this.isNonlinear = true;
    this._VdLast = undefined;
  }
  nodes() { return [this.anode, this.cathode]; }
  _resetIter() { this._VdLast = undefined; }

  /** SPICE-style pnjlim voltage limiting. */
  _limit(Vd, iteration) {
    const nVt = this.n * Vt;
    const Vcrit = nVt * Math.log(nVt / (Math.SQRT2 * this.Is));
    if (iteration === 0 || this._VdLast === undefined) {
      // First iteration: don't let Vd exceed Vcrit (clamp open-circuit overshoot)
      return Math.min(Vd, Vcrit);
    }
    const Vprev = this._VdLast;
    if (Vd > Vcrit && Math.abs(Vd - Vprev) > 2 * nVt) {
      if (Vprev > 0) {
        const arg = 1 + (Vd - Vprev) / nVt;
        if (arg > 0) return Vprev + nVt * Math.log(arg);
        return Vcrit;
      }
      return Vcrit;
    }
    return Vd;
  }

  _currentAndConductance(Vd) {
    const nVt = this.n * Vt;
    // Clamp Vd to avoid exp() overflow
    const Vc = Math.max(Math.min(Vd, this.Vclamp), -this.Vclamp);
    const e = Math.exp(Vc / nVt);
    const Id = this.Is * (e - 1);
    const gd = (this.Is / nVt) * e;
    return { Id, gd };
  }

  stampDC(G, b, ctx) {
    const ia = ctx.nodeIndex(this.anode);
    const ic = ctx.nodeIndex(this.cathode);
    const Va = ctx.nodeVoltageFromX(this.anode);
    const Vc = ctx.nodeVoltageFromX(this.cathode);
    const VdRaw = Va - Vc;
    const Vd = this._limit(VdRaw, ctx.iteration ?? 0);
    this._VdLast = Vd;
    const { Id, gd } = this._currentAndConductance(Vd);
    const Ieq = Id - gd * Vd;

    if (ia >= 0) G[ia][ia] += gd;
    if (ic >= 0) G[ic][ic] += gd;
    if (ia >= 0 && ic >= 0) { G[ia][ic] -= gd; G[ic][ia] -= gd; }
    if (ia >= 0) b[ia] -= Ieq;
    if (ic >= 0) b[ic] += Ieq;
  }

  currentThrough(state) {
    const Va = state.nodeVoltages[this.anode] ?? 0;
    const Vc = state.nodeVoltages[this.cathode] ?? 0;
    return this._currentAndConductance(Va - Vc).Id;
  }
}

/**
 * Colour LED — same as Diode but with colour-specific Is/n and a brightness
 * computed from forward current.
 */
// Is tuned so that V_f at 10 mA matches typical datasheets.
const LED_PARAMS = {
  red:    { Is: 1e-20, n: 1.7, ratedCurrent: 0.020 },   // Vf ≈ 2.0 V
  green:  { Is: 1e-22, n: 1.9, ratedCurrent: 0.020 },   // Vf ≈ 2.2 V
  yellow: { Is: 1e-21, n: 1.8, ratedCurrent: 0.020 },   // Vf ≈ 2.1 V
  blue:   { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },   // Vf ≈ 3.1 V
  white:  { Is: 1e-28, n: 2.0, ratedCurrent: 0.020 },
};

export class LED extends Diode {
  constructor(name, anode, cathode, color = 'red') {
    const p = LED_PARAMS[color] ?? LED_PARAMS.red;
    super(name, anode, cathode, { Is: p.Is, n: p.n });
    this.color = color;
    this.ratedCurrent = p.ratedCurrent;
  }
  /** 0..1 brightness based on forward current. */
  brightness(state) {
    const I = Math.max(0, this.currentThrough(state));
    return Math.min(1.0, I / this.ratedCurrent);
  }
}

/**
 * Ebers-Moll NPN BJT (simplified, injection version).
 *   I_F = Is · (exp(V_BE/Vt) − 1)
 *   I_R = Is · (exp(V_BC/Vt) − 1)
 *   I_C = αF·I_F − I_R
 *   I_B = (1−αF)·I_F + (1−αR)·I_R
 *   I_E = −(I_C + I_B)
 */
export class BJT_NPN {
  constructor(name, collector, base, emitter, { Is = 1e-15, betaF = 100, betaR = 1 } = {}) {
    this.name = name;
    this.c = collector;
    this.b = base;
    this.e = emitter;
    this.Is = Is;
    this.betaF = betaF;
    this.betaR = betaR;
    this.alphaF = betaF / (betaF + 1);
    this.alphaR = betaR / (betaR + 1);
    this.isNonlinear = true;
  }
  nodes() { return [this.c, this.b, this.e]; }

  stampDC(G, bvec, ctx) {
    const Vbe = ctx.nodeVoltageFromX(this.b) - ctx.nodeVoltageFromX(this.e);
    const Vbc = ctx.nodeVoltageFromX(this.b) - ctx.nodeVoltageFromX(this.c);
    const clamp = (x) => Math.max(Math.min(x, 40), -40);
    const IF = this.Is * (Math.exp(clamp(Vbe) / Vt) - 1);
    const IR = this.Is * (Math.exp(clamp(Vbc) / Vt) - 1);
    const gF = (this.Is / Vt) * Math.exp(clamp(Vbe) / Vt);
    const gR = (this.Is / Vt) * Math.exp(clamp(Vbc) / Vt);

    const Ic = this.alphaF * IF - IR;
    const Ib = (1 - this.alphaF) * IF + (1 - this.alphaR) * IR;
    const Ie = -(Ic + Ib);

    // Linearize: dIc/dVbe = αF·gF, dIc/dVbc = -gR
    //            dIb/dVbe = (1-αF)·gF, dIb/dVbc = (1-αR)·gR
    const ic_vbe = this.alphaF * gF;
    const ic_vbc = -gR;
    const ib_vbe = (1 - this.alphaF) * gF;
    const ib_vbc = (1 - this.alphaR) * gR;
    const ie_vbe = -(ic_vbe + ib_vbe);
    const ie_vbc = -(ic_vbc + ib_vbc);

    const addG = (node, eqNode, dIdV) => {
      const i = ctx.nodeIndex(node);
      const j = ctx.nodeIndex(eqNode);
      if (i < 0) return;
      if (j >= 0) G[i][j] += dIdV;
    };
    const addSelf = (node, dIdV) => {
      const i = ctx.nodeIndex(node);
      if (i >= 0) G[i][i] += dIdV;
    };

    // Current entering C is +Ic. Stamp KCL: for each node n, sum of currents out = 0.
    // Contribution to node n's row from dependence on V_m.
    // Use chain rule: Ic depends on Vbe = Vb−Ve, Vbc = Vb−Vc.
    const stampCurrent = (node, I_val, dI_dVbe, dI_dVbc) => {
      const i = ctx.nodeIndex(node);
      if (i < 0) return;
      // Current flowing out of node is -I_val (since +Ic means into the collector node)
      // Actually: we are doing KCL at each node: sum of currents LEAVING = 0.
      // Model current entering the collector = Ic. So current leaving node c via this element = -Ic.
      // MNA convention: b[i] -= (Ieq) where Ieq is the non-linear residual.
      // We'll compute: f_i = -I_val + sum(dI/dV * V_j) for linearization.
      const ib_ = ctx.nodeIndex(this.b);
      const ic_ = ctx.nodeIndex(this.c);
      const ie_ = ctx.nodeIndex(this.e);
      // dI/dV_b = dI/dVbe + dI/dVbc
      // dI/dV_e = -dI/dVbe
      // dI/dV_c = -dI/dVbc
      const dI_dVb = dI_dVbe + dI_dVbc;
      const dI_dVe = -dI_dVbe;
      const dI_dVc = -dI_dVbc;

      // KCL: current INTO the node from this element. Use sign (+1 for entering, -1 for leaving).
      // signConvention below: +I_val is current ENTERING the node.
      // Linearized: I_lin = I_val + dI/dV · (V_new - V_prev)  ≈ Ieq + g·V_new
      // Stamp: G[i][j] -= dI/dV_j  (because we move  -g·V_new to LHS)
      // b[i]  -= (I_val - dI/dV · V_prev)
      const Vb = ctx.nodeVoltageFromX(this.b);
      const Vc = ctx.nodeVoltageFromX(this.c);
      const Ve = ctx.nodeVoltageFromX(this.e);
      const Ieq = I_val - dI_dVb * Vb - dI_dVc * Vc - dI_dVe * Ve;

      if (ib_ >= 0) G[i][ib_] -= dI_dVb;
      if (ic_ >= 0) G[i][ic_] -= dI_dVc;
      if (ie_ >= 0) G[i][ie_] -= dI_dVe;
      bvec[i] += Ieq;
    };

    // Current ENTERING collector = Ic (conventional)
    stampCurrent(this.c, Ic, ic_vbe, ic_vbc);
    // Current ENTERING base = Ib
    stampCurrent(this.b, Ib, ib_vbe, ib_vbc);
    // Current ENTERING emitter = Ie (= -Ic-Ib)
    stampCurrent(this.e, Ie, ie_vbe, ie_vbc);
  }
}
