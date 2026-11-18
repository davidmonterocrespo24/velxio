/**
 * LM358 SPICE subcircuit macro-model.
 *
 * Source: National Semiconductor (now TI), redistributed for SPICE
 * simulation. Sourced via stmbl/hw/spice/LM358.lib (MIT).
 *
 * Models a single LM358 op-amp (the part is a dual, but this subckt
 * represents one channel). Captures:
 *   - Open-loop gain ~100 dB
 *   - Gain-bandwidth product ~1 MHz
 *   - Slew rate ~0.5 V/µs
 *   - Single-supply / rail-to-rail-input behaviour with ~1.5V output
 *     headroom from V+
 *
 * Pin order (subckt declaration):
 *   1  IN+
 *   2  IN-
 *   99 V+   (positive supply — wired to vcc_rail in velxio emissions)
 *   50 V-   (negative supply — wired to 0 in velxio emissions)
 *   28 OUT
 *
 * Used by componentToSpice.ts:opamp-lm358 to replace the prior
 * behavioural B-source clamp with a real macro-model. Provides true
 * slew limiting, GBW roll-off, and saturation curves so AC analyses
 * (Bode plots, oscillator startup) produce textbook results.
 *
 * Local change to National's text: F6 was `F6 50 99 POLY(1) V6 300U 1` and
 * is now `F6 50 99 POLY(1) V6 0 1`. The 300U constant pulled 300 uA out of
 * V- and pushed it INTO V+, which against I2's 75 uA left the part drawing a
 * NEGATIVE supply current below about 10 V (-46 uA at 5 V): it fed its own
 * supply (velxio/velxio-prod#190). With the constant removed the model draws
 * 254 uA at 5 V and 462 uA at 30 V with no load, National's LM358-N typical
 * per amplifier (0.5 / 1 mA per package of two), which is what the NOTE
 * "simulated supply current is 1/2 of total device current" in the original
 * file aims at. The I(V6) term is kept: it moves the output's sinking current
 * from V+ to V-.
 */
export const LM358_SUBCKT = `.SUBCKT LM358 1 2 99 50 28
IOS 2 1 5N
R1 1 3 500K
R2 3 2 500K
I1 99 4 100U
R3 5 50 517
R4 6 50 517
Q1 5 2 4 QX_LM358
Q2 6 7 4 QX_LM358
C4 5 6 128.27P
I2 99 50 75U
EOS 7 1 POLY(1) 16 49 2E-3 1
R8 99 49 60K
R9 49 50 60K
V2 99 8 1.63
D1 9 8 DX_LM358
D2 10 9 DX_LM358
V3 10 50 .635
EH 99 98 99 49 1
G1 98 9 POLY(1) 5 6 0 9.8772E-4 0 .3459
R5 98 9 101.2433MEG
C3 98 9 200P
G3 98 15 9 49 1E-6
R12 98 15 1MEG
C5 98 15 7.9577E-14
G4 98 16 3 49 5.6234E-8
L2 98 17 15.9M
R13 17 16 1K
F6 50 99 POLY(1) V6 0 1
E1 99 23 99 15 1
R16 24 23 17.5
D5 26 24 DX_LM358
V6 26 22 .63V
R17 23 25 17.5
D6 25 27 DX_LM358
V7 22 27 .63V
V5 22 21 0.27V
D4 21 15 DX_LM358
V4 20 22 0.27V
D3 15 20 DX_LM358
L3 22 28 500P
RL3 22 28 100K
.MODEL DX_LM358 D(IS=1E-15)
.MODEL QX_LM358 PNP(BF=1.111E3)
.ENDS LM358`;
