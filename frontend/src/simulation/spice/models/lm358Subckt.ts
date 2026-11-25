/**
 * LM358 SPICE subcircuit macro-model.
 *
 * Source: National Semiconductor (now TI), redistributed for SPICE
 * simulation. Sourced via stmbl/hw/spice/LM358.lib (MIT).
 *
 * Models a single LM358 op-amp (the part is a dual, but this subckt
 * represents one channel). As this text measures, on 5 V unless said
 * (opamp-texts-match-models.test.ts holds the swing and input figures,
 * velxio/velxio-prod#128):
 *   - open-loop gain 99.9 dB, input offset 2 mV;
 *   - gain-bandwidth about 1 MHz (a follower is 3 dB down at 1.15 MHz);
 *   - slew rate 0.49 V/us;
 *   - output from 5 mV above V- to about 1 V below V+, a little less into
 *     a heavier load: 4.02 V open, 3.96 V into 10 kOhm, 3.89 V into
 *     2 kOhm, 3.84 V into 1 kOhm; 14.02 V open on 15 V, 28.86 V on 30 V
 *     into 10 kOhm. That is closer to V+ than the part's datasheet: TI
 *     guarantees no more than 1.5 V below V+ at 5 V into 2 kOhm and gives
 *     2 V below as typical at 30 V into 10 kOhm (SLOS068);
 *   - inputs from V- up to V+: as a comparator it still switches with both
 *     inputs at 4.9 V on 5 V. A real LM358's common-mode input range ends
 *     1.5 V below V+ (SLOS068), which the model does not enforce, so a
 *     design has to.
 *
 * Pin order (subckt declaration):
 *   1  IN+
 *   2  IN-
 *   99 V+   (positive supply — wired to vcc_rail in velxio emissions)
 *   50 V-   (negative supply — wired to 0 in velxio emissions)
 *   28 OUT
 *
 * Two local changes to National's text, both to TI's datasheet (SLOS068,
 * LM358: input bias current -20 nA typ; output swing from the negative rail
 * 5 mV typ, 20 mV max at VS = 5 V, RL <= 10 kOhm; velxio/velxio-prod#134):
 *   - R1 and R2 were 500K: 1 MOhm between the inputs, which pulled a
 *     10k/10k reference in a comparator 12 mV off 2.5 V, about 100 times
 *     what the bias current does. They make node 3 the inputs' midpoint,
 *     which G4 senses for the common-mode term without loading it, so
 *     they can be larger: 50MEG each, 100 MOhm, takes 25 nA at 2.5 V
 *     across the inputs, about the bias current, and the reference stays
 *     within 0.6 mV. Not more: an input nothing else holds (a filter's
 *     capacitor before its pin drives it) is held by them against IOS's
 *     5 nA, and at 1 GOhm that pushed it 4 V above a 5 V supply.
 *   - D2 and V3 clamp the second stage, and so the output, above V-. With
 *     V3 at .635 and D2 an ordinary diode (D2 dropping 0.655 V at the
 *     stage's full drive) the output saturated 19 mV BELOW V-, and a
 *     follower of 0 V sat at 21 mV, where the drive and D2's drop are
 *     smaller. D2 now has a model of its own with a sharper knee (N=0.25)
 *     and V3 is .169: the output saturates 5 mV above V- (into 10 kOhm or
 *     open), the datasheet's typical, and a follower of 0 V reads 17 mV,
 *     inside its 20 mV maximum. D1 and D3-D6 keep National's model.
 * Neither change moves a stage in its linear range: a follower of 2.5 V
 * reads the same 2.502 V.
 *
 * Used by componentToSpice.ts for opamp-lm358, and for opamp-lm324, the
 * LM358's quad sibling, to replace the prior behavioural B-source clamps
 * with a real macro-model. Provides true slew limiting, GBW roll-off, and
 * saturation curves so AC analyses (Bode plots, oscillator startup)
 * produce textbook results.
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
R1 1 3 50MEG
R2 3 2 50MEG
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
D2 10 9 DX2_LM358
V3 10 50 .169
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
.MODEL DX2_LM358 D(IS=1E-15 N=0.25)
.MODEL QX_LM358 PNP(BF=1.111E3)
.ENDS LM358`;
