# Intel 4040 — Delta Spec vs 4004

Source (in `autosearch/pdfs/`):

- **[M40]** *MCS-40 User's Manual for Logic Designers*, Intel, **Nov 1974**. Page numbers below are the printed Ch. 1 footers ("1‑5", etc.).

The 4040 (1974) is binary-compatible with the 4004 — the 46 original opcodes execute identically — and adds 14 new opcodes plus interrupt, single-step, extended ROM/register banks ([M40] §1 p. 1‑1, summary p. 1‑22).

---

## 1. Pin contract — 24-pin DIP ([M40] Pin Description table pp. 1‑5/1‑6, Fig. 1‑5)

Vss = GND; Vdd = Vss − 15.0 V ±5%; PMOS, two-phase clock.

| Pin | Name | Description ([M40] verbatim where quoted) |
|---|---|---|
| 1–4 | D0..D3 | Bidirectional 4-bit data/address bus |
| 5 | STPA | "STOP ACKNOWLEDGE output … open drain" |
| 6 | STP | "STOP input … logic 1 causes the processor to enter the STOP mode" |
| 7 | INT | "INTERRUPT input signal" |
| 8 | INTA | "INTERRUPT ACKNOWLEDGE output … remains active until cleared by the new BRANCH BACK and SRC (BBS) instruction"; open drain |
| 9 | Vss | GND (most positive) |
| 10, 11 | Φ1, Φ2 | Non-overlapping clocks |
| 12 | RESET | "A 1 level … forces the program counter to 0. To completely clear … RESET must be applied for **96 clock cycles (12 machine cycles)**" |
| 13 | TEST | sampled by JCN |
| 14 | Vdd | Main supply, Vss − 15 V |
| 15 | Vdd2 | Output-buffer supply (may be reduced) |
| 16 | SYNC | Marks start of instruction cycle |
| 17–20 | CM-RAM0..3 | RAM bank select |
| 21 | Vdd1 | Timing-circuit supply; "only SYNC will be generated when this pin is the only active Vdd" — standby |
| 22 | CM-ROM0 | ROM bank-0 select |
| 23 | CM-ROM1 | ROM bank-1 select (NEW vs 4004) |
| 24 | CY | "CARRY output buffer … updated at X1"; open drain (NEW) |

vs the 4004 the 4040 adds: STP, STPA, INT, INTA, a second CM-ROM line, a CY pin, and dual standby supplies. INT/STP/STPA/INTA are active-high logic-1 (negative voltage).

## 2. New instructions — 14 total ([M40] p. 1‑22 summary)

All 14 use OPR=`0000` and live in OPA `0001..1110` of the 4004 (NOP `0000 0000` is preserved).

| Mnemonic | Opcode | Effect |
|---|---|---|
| HLT | `01` | Halt; HALT and STOP FFs set at X3 |
| BBS | `02` | Branch back from interrupt: restore PC, SRC reg, index-bank FF |
| LCR | `03` | ACC ← Command Register |
| OR4 | `04` | ACC ← ACC OR R4 |
| OR5 | `05` | ACC ← ACC OR R5 |
| AN6 | `06` | ACC ← ACC AND R6 |
| AN7 | `07` | ACC ← ACC AND R7 |
| DB0 | `08` | Designate ROM bank 0 (CM-ROM0); takes effect 3 cycles later |
| DB1 | `09` | Designate ROM bank 1 (CM-ROM1) |
| SB0 | `0A` | Select index-register bank 0 |
| SB1 | `0B` | Select index-register bank 1 |
| EIN | `0C` | Enable interrupt |
| DIN | `0D` | Disable interrupt |
| RPM | `0E` | Read program memory (via 4289 device) |

`0F` is unused. The brief asked about a "JNT" — there is none; "jump on no test" is just JCN with C1=1, C4=1 (same as on 4004).

## 3. Interrupt sequence ([M40] §"INTERRUPT and STOP Control Logic" pp. 1‑11..1‑13, Fig. 1‑11)

When INT is sampled high at M2 and EIN is in effect:
1. Current instruction completes.
2. The next cycle becomes a forced JMS to **page 0, location 3** ([M40] p. 1‑12 verbatim: *"The subroutine address is forced to be page 0, location 3"*) — i.e. PC ← `0x003`. The pre-interrupt PC (NOT incremented) is pushed.
3. At **X3** of that cycle the **INTA flip-flop is set** and the INTA pin asserts.
4. The index-register bank FF and the SRC register are saved automatically; bank FF resets to 0.
5. Handler runs from `0x003`. INTA stays asserted (blocking further interrupts) until the handler executes **BBS**, which pops the stack, restores PC, re-emits the saved SRC at X2/X3 with CM-ROM/CM-RAM at X2 (re-arming the previously selected ROM/RAM), restores the bank FF, and clears INTA.

There is no vector table — INT always lands at `0x003`.

## 4. STOP / STOP-ACK protocol ([M40] §"STOP/HALT Mode Operation" pp. 1‑10..1‑11, Fig. 1‑9, 1‑10)

- STP=1 latched at M2 → internal STOP FF set at X3 → CPU executes NOPs in a loop (clock keeps running) and STPA asserts.
- Resume: STP=0 latched at M2 of cycle N → STOP FF reset at X3 → "Normal processor operation resumes at instruction cycle N+1" ([M40] p. 1‑10).
- HLT sets STOP and HALT FFs at X3; exit via STP pulse OR INT (Fig. 1‑13 shows INT-exit forcing HALT FF reset, then taking the interrupt at `0x003`).
- INT and STP latched together: **STP wins** ([M40] p. 1‑13).

## 5. Extended index-register file — 24 × 4 bits ([M40] p. 1‑11)

Three banks of 8 registers (R0..R7):
- **Bank 0** (default after RESET, SB0): low 8 registers.
- **Bank 1** (SB1): mirror low 8.
- **Upper bank R8..R15**: shared, always visible.

R16..R23 are **not directly named** — they are Bank-1's incarnation of R0..R7. SB0/SB1 FF auto-saved/restored across interrupt.

## 6. PC stack — 8 × 12 bits = **7-deep** subroutine nesting ([M40] §"Extended Address Register Stack" p. 1‑12; bullet on p. 1‑1)

One slot holds the live PC, the other 7 are return addresses; on overflow the deepest is lost (same behaviour as 4004).

## 7. Other deltas

- **Two CM-ROM lines** (DB0/DB1 select) → 8 K × 8 ROM addressable ([M40] p. 1‑12). DB0/DB1 take effect on the **3rd cycle after execution**, and INT/STOP/HALT are internally inhibited during those 3 cycles ([M40] p. 1‑13).
- **CY exposed on pin 24**, updated at X1 ([M40] p. 1‑6).
- RESET clears interrupt enable; an EIN must be re-issued before INT is honored ([M40] p. 1‑13).
- Cycle time same as 4004: 8 clock periods per machine cycle.

---

## Open questions

- Exact phase relationships of **STPA** and **INTA** open-drain transitions — [M40] Fig. 1‑9 implies STPA goes active the cycle after STP is latched, but the scan is hard to read. Verify against silicon or markablov/i40xx source.
- Behaviour when INT arrives during a 2-byte instruction (JMS, FIM, JCN, JUN, ISZ): [M40] says the current instruction "completes" before the forced JMS, but doesn't tabulate the cycle accounting.
- Whether DB0/DB1's 3-cycle inhibit also blocks WRR/RDR to the previously-selected bank during the transition — [M40] is silent.
