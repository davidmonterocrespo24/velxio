# Intel 4004 Authoritative Specification

Sources (in `autosearch/pdfs/`):

- **[M4]** *MCS-4 Micro Computer Set Users Manual*, Intel, **Feb 1973** (175 pp). Page numbers below are the printed body footers.
- **[M40]** *MCS-40 User's Manual*, Intel, Nov 1974 — Ch. 1 also describes the 4004; used as cross-check.
- **[I]** olbits MCS-4 instruction reference (e4004.szyc.org/iset.html) — used only to cross-check opcode hex against [M4] Table V.

---

## 1. Pin contract — 16-pin DIP ([M4] §III, pp. 7–9; supplies p. 102)

The 4004 (Nov 1971) is the first commercial single-chip microprocessor. PMOS, two-phase dynamic clock; **Vss = GND, Vdd = −15 V ±5%**. Logic 1 = low (negative) voltage; logic 0 = Vss ([M4] p. 6).

| Pin | Name | Dir |
|---|---|---|
| 1–4 | D0..D3 | I/O — multiplexed 4-bit data/address bus (D3 = MSB) |
| 5 | Vss | GND |
| 6, 7 | Φ1, Φ2 | In — non-overlapping clocks |
| 8 | SYNC | Out |
| 9 | RESET | In |
| 10 | TEST | In |
| 11 | CM-ROM | Out |
| 12 | Vdd | −15 V |
| 13–16 | CM-RAM3..CM-RAM0 | Out (CM-RAM0 = pin 16) |

[M4] p. 14 confirms pin 9 = RESET, pin 10 = TEST. CM-RAM0 auto-selected after RESET ([M4] pp. 6, 14).

## 2. The 8-phase instruction cycle ([M4] Fig. 2 p. 6, text pp. 5–6)

One cycle = **8 clock periods** = 10.8 µs at 750 kHz. Phases in order: **A1, A2, A3, M1, M2, X1, X2, X3**. Verbatim p. 5: *"the CPU sends 12 bits of address (in three 4-bit bytes on the data bus) … in the first three cycles (A1, A2, A3). … The selected ROM chip sends back 8 bits of instruction (OPR, OPA) to the CPU in the next two cycles (M1, M2)."*

| Phase | Driver | Contents |
|---|---|---|
| A1 | CPU | PC[3:0] — **low nibble first** (Fig. 2: "Lower 4-bit Address") |
| A2 | CPU | PC[7:4] |
| A3 | CPU | PC[11:8] (high 4 bits = chip select 1-of-16) |
| M1 | ROM | OPR (high nibble of opcode) |
| M2 | ROM | OPA (low nibble) |
| X1 | CPU | execute (idle on bus for most ops) |
| X2 | CPU/ROM | SRC: chip-select addr; I/O read: ROM/RAM drives ACC data |
| X3 | CPU | SRC: char addr; otherwise idle |

Endianness on the bus: **PC low-nibble first**, chip-select last.

## 3. SYNC ([M4] p. 6, Fig. 2)

Generated once every 8 clocks; one clock wide; asserted during **phase X3** to mark end-of-cycle / beginning of A1 of the next. 4001/4002 derive their internal phase counters from SYNC + Φ2.

## 4. CM-ROM / CM-RAM strobes ([M4] pp. 13–14, Fig. 4)

- **SRC**: at **X2**, CM-ROM and the selected CM-RAMᵢ go true together while the bus carries the 4 high bits of the SRC address (chip select). At **X3** the bus carries char address.
- **I/O & RAM instruction (WRM/RDM/WRR/...)**: at **M2** of that instruction's cycle, CM-ROM + selected CM-RAMᵢ are re-asserted so the latched chip executes OPA (which is on the bus at M2) ([M4] p. 14, step 4).

## 5. Register file ([M4] §III.A pp. 7–10, Tables III–IV)

- **Program counter & stack**: 4 × 12 bits — one is the live PC, three form the push-down stack ⇒ **3-deep subroutine stack** ([M4] p. 7).
- **Index registers**: 16 × 4 bits, also addressable as 8 × 8-bit pairs R0R1…R14R15 ([M4] §III.B.2 p. 12).
- **Accumulator** 4 bits + **carry/link** flip-flop CY ([M4] p. 8).
- **Command-control register** (3 bits, latched by DCL).

## 6. Instruction set — 46 opcodes ([M4] Table V pp. 15–16, cross-checked with [I])

`*` = 2-byte. First byte shown.

| Opcode | Mnemonic | Notes |
|---|---|---|
| `00` | NOP | |
| `1C` (`10..1F`) | *JCN cccc | + addr byte; in-page branch |
| `20,22,…,2E` | *FIM Pn | + imm8 → reg pair |
| `21,23,…,2F` | SRC Pn | send pair as RAM/ROM addr at X2/X3 |
| `30…3E` | FIN Pn | indirect ROM fetch via P0 |
| `31…3F` | JIN Pn | jump to (PC.high : Pn) |
| `40..4F` | *JUN | + addr byte; 12-bit jump |
| `50..5F` | *JMS | + addr byte; push PC+2; jump |
| `60..6F` | INC Rn | |
| `70..7F` | *ISZ Rn | + addr; in-page branch if ≠0 |
| `80..8F` | ADD Rn | A ← A + Rn + CY |
| `90..9F` | SUB Rn | A ← A + ~Rn + ~CY |
| `A0..AF` | LD Rn | |
| `B0..BF` | XCH Rn | CY unaffected |
| `C0..CF` | BBL d | pop; A ← d |
| `D0..DF` | LDM d | |
| `E0..EF` | I/O+RAM grp | WRM(E0) WMP(E1) WRR(E2) WPM(E3) WR0..3(E4..E7) SBM(E8) RDM(E9) RDR(EA) ADM(EB) RD0..3(EC..EF) |
| `F0..FD` | ACC group | CLB(F0) CLC(F1) IAC(F2) CMC(F3) CMA(F4) RAL(F5) RAR(F6) TCC(F7) DAC(F8) TCS(F9) STC(FA) DAA(FB) KBP(FC) DCL(FD); FE/FF unused |

## 7. JCN condition encoding ([M4] p. 27 + p. 16 footnote (1))

OPA bits **C1 C2 C3 C4** (D3..D0): C1=1 → invert sense; C2=1 → ACC==0; C3=1 → CY==1; C4=1 → TEST pin == 0 (high voltage, i.e. logic-0). Logic ([M4] p. 28):
`JUMP = C1·((ACC=0)·C2 + (CY=1)·C3 + TEST·C4) + ~C1·~(…)`. **Page-wrap exception**: if JCN sits at words 254/255, the taken target lands on the *next* page ([M4] p. 28).

## 8. JMS / BBL ([M4] §III.B.3 pp. 12–13, Table IV; JMS p. 28)

JMS is 2 bytes; **the return address pushed = PC+2** ([M4] p. 12 footnote (3)). Push moves PC up one stack level; depth = 3. Verbatim [M4] p. 13: *"If a fourth JMS occurs, the deepest return address (the first one stored) is lost."* BBL pops + ACC ← D.

## 9. TEST pin ([M4] p. 14 + p. 28)

Asynchronous; sampled by condition logic only when JCN is being executed. "Jump if test = logic 0" means the pin is at the high (Vss) level — i.e. active-low in conventional polarity.

## 10. Reset state ([M4] §III.A.5 p. 9)

Verbatim: *"During reset … all RAM's and static FF's are cleared, and the data bus is set to 0. After reset, program control will start from 0 step and CM-RAM0 is selected. To completely clear all registers and RAM locations in the CPU the reset signal must be applied for at least 8 full instruction cycles (64 clock cycles) … (256 clock cycles for the 4002 RAM)."*

→ After RESET held ≥ 64 CPU clocks: **PC=0, ACC=0, CY=0, all 16 index regs = 0, all 3 stack words = 0, CM-RAM0 selected, condition FF = 0**.

---

## Open questions

- **SYNC pulse exact polarity / phase boundary** — [M4] Fig. 2 is a poor scan; the pulse sits on X3 but the rising-vs-falling edge isn't recoverable from the OCR. Cross-validate against the 4004.com redrawn schematics.
- **CM-ROM during a normal opcode fetch** — [M4] Fig. 4 details only SRC and the I/O instruction; for a plain fetch CM-ROM is asserted A3→M2 in every emulator surveyed but the manual does not say so explicitly.
- **What X1 is used for on most instructions** — Table V doesn't tabulate per-phase activity; reference emulators treat X1 as a no-op cycle for fetch+execute.
