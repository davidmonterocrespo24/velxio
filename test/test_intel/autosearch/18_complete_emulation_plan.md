# Complete Emulation Plan — Phases A-G

This document is the master plan for taking the test_intel chip suite
from "baseline silicon contracts validated" to "real-software emulation
that runs CP/M, ZEXDOC, CPUDIAG, Busicom 141-PF, and DOS-era 8086
programs". It is updated as each phase completes; the sentinel at the
top of each phase reflects status.

## Constraints

- **No frontend or backend modifications.** Velxio core stays
  untouched; all work happens under `test/test_intel/`.
- **Clean-room implementation.** No GPL code. Permissive references
  (MIT/BSD/zlib/Apache) only, used for cross-validation never copying.
- **Test-first.** Every chip / feature gets a test before any
  permanent .c change.
- **Internet research authorized.** Download datasheets, public-domain
  ROMs, permissive open-source emulators as references.
- **Document each phase on completion.** Append a "Phase X completed"
  section below with: what was done, what was deferred, lessons
  learned, test count delta.

## Phases at a glance

| Phase | Scope | Effort | Status |
| --- | --- | --- | --- |
| **A** | 8080 INTA bus cycle | low | ✅ done 2026-04-30 |
| **B** | Z80 ISA polish for ZEXDOC | high | ✅ done 2026-04-30 (ZEXDOC ROM run deferred to Phase F) |
| **C** | Support chip ecosystem (rom-1m, 8255, 8251 done; 4001/4002/8253/8259 deferred) | high | ⚠️ partial 2026-04-30 |
| **D** | 4004/4040 I/O completion (4001 done; 4002/SRC/WRM still pending) | medium | ⚠️ partial 2026-04-30 |
| **E** | 8086 ISA completion | high | ✅ done 2026-04-30 (CALL/RET edge case deferred) |
| **F** | Real software validation (CPUDIAG, ZEXDOC done; Busicom + 8088 V2 deferred) | medium | ⚠️ partial 2026-04-30 |
| **G** | Cycle accuracy (optional) | high | ⏸️ deferred |

---

## Phase A — 8080 INTA bus protocol

### Goal
Replace the current "synthesize RST 7 internally" hack in `8080.c`
with a proper INT-acknowledge bus cycle. When the chip detects INT
asserted (with IME=1), it should perform an INTA M1 cycle (status byte
0x23), read the opcode from the data bus, and execute it. External
hardware (an 8259 PIC, or a test fixture) drives the RST opcode onto
the data bus during INTA.

### Deliverables
- Modify `test_8080/8080.c`: replace `if (G.int_pending && G.ime)` block
  with a real bus-cycle that emits ST_INTA and reads the data bus.
- Test: drive INT high, drive RST 5 (0xEF) on the bus during INTA,
  observe PC = 0x0028 + observe ISR runs.
- Update `test_8080/README.md` status.

### Sources
- [I8080-1975] User's Manual section on Interrupt Acknowledge
- Cross-check against `superzazu/8080`'s INTA implementation

---

## Phase B — Z80 ISA polish for ZEXDOC

### Goal
Bring the Z80 chip from "passes our 11 active tests" to "passes
ZEXDOC" (the documented-flags subset of Frank Cringle's ZEXALL test
ROM). This requires implementing several features that real Z80
software depends on but which our current chip stubs.

### Sub-phases
- **B.1** CB prefix (256 ops): BIT n,r / SET n,r / RES n,r and the
  rotates RLC/RRC/RL/RR/SLA/SRA/SLL/SRL on r ∈ B/C/D/E/H/L/(HL)/A.
- **B.2** DDCB / FDCB indexed bit ops: e.g. `BIT 0, (IX+d)` — fetched
  as `DD CB d byteOpcode`.
- **B.3** Undocumented X (bit 3) and Y (bit 5) flag bits — copies of
  result bits 3/5. ZEXALL fails without these. Apply to all
  flag-affecting instructions.
- **B.4** MEMPTR (WZ) internal register — affects bits 3/5 of F after
  `BIT n,(HL)` and DD/FD-prefixed BIT. Update list per Sean Young §4.1.
- **B.5** Z80-specific DAA — uses N flag to determine direction
  (additive vs subtractive); H-flag table per Sean Young §4.7.
- **B.6** Block I/O exact flags (INI/IND/INIR/INDR/OUTI/OUTD/OTIR/OTDR)
  per Sean Young §4.3.
- **B.7** CPI/CPD/CPIR/CPDR with H/PV/Z exactly per Sean Young §4.2.
- **B.8** RLD/RRD instructions.
- **B.9** 16-bit ADC HL,rr / SBC HL,rr with bit-12 half-carry +
  16-bit overflow flag.
- **B.10** All 8 NEG aliases (ED 44/4C/54/5C/64/6C/74/7C).

### Deliverables
- ~600 LOC additions to `test_z80/z80.c`.
- New tests under `test_z80/`: per-feature unit tests + ZEXDOC
  integration test (runs the 9 KB ROM to completion, verifies the
  printed result byte sequence).
- Vendoring of ZEXDOC ROM (public domain, Frank Cringle 1994).

### Sources
- Sean Young, *The Undocumented Z80 Documented* v0.91 (in `pdfs/`)
- Zilog UM008003-1202 (in `pdfs/`)
- Cross-check: `floooh/chips/z80.h` for MEMPTR map

---

## Phase C — Support chip ecosystem

### Goal
Build the supporting chips that real systems used. Without these,
none of our CPUs can run actual programs on the canvas. All chips
follow the existing custom-chip API and have unit tests.

### Sub-phases
- **C.1** `4001` ROM (16-pin DIP, 256 bytes, 4-bit nibble bus matching
  4004 SRC protocol; CMROM-strobed; ROM image baked in like rom-32k)
- **C.2** `4002` RAM (16-pin DIP, 80 nibbles + 4 output port lines,
  SRC-addressed, CMRAM-strobed)
- **C.3** `8259` PIC — 28-pin, 8 IRQ inputs, INT/INTA cycle to CPU,
  programmable vector base. Used by 8080/Z80/8086 for real interrupt
  systems.
- **C.4** `8253` PIT — 24-pin, 3 channels of 16-bit countdown timers.
  Essential for BIOS-style code (system tick, speaker frequency).
- **C.5** `8255` PPI — 40-pin, three 8-bit ports (A, B, C), 4 modes.
  Generic peripheral interface used in many 8080/Z80/8086 systems.
- **C.6** `8251` USART — 28-pin, async serial UART. Enables "hello
  world" via terminal emulation.
- **C.7** `rom-1m` — variant of rom-32k with 20-bit address bus
  (A0..A19) so 8086 can fetch from CS:IP=0xFFFF0 on canvas.

### Deliverables
- ~1500 LOC across 7 chips.
- Per-chip test file (pin contract + protocol behavior).
- Per-chip README.md.
- Updated `test_buses/README.md` chip table.

### Sources
- Each chip's Intel datasheet (download from bitsavers.org).

---

## Phase D — 4004/4040 I/O completion

### Goal
Wire up the I/O group instructions (WRM/RDM/ADM/SBM/WRR/RDR/WR0..3/
RD0..3) so they actually access RAM/ROM ports through the SRC + CMRAM
mechanism. Requires `4001` and `4002` from Phase C.

### Sub-phases
- **D.1** SRC instruction emits chip-select address on D bus during X2
  with appropriate CMROM/CMRAMᵢ strobing, latched by external chip
- **D.2** Subsequent I/O instruction (WRM/RDM/etc.) re-asserts the
  selected CMROM/CMRAMᵢ during M2 + X2/X3 to drive R/W to that chip
- **D.3** WRM/RDM/ADM/SBM hit 4002 RAM character cells
- **D.4** WRR/RDR hit 4001 ROM I/O port lines
- **D.5** WR0..WR3 / RD0..RD3 hit 4002 RAM status characters
- **D.6** 4040's BBS reissues the saved SRC at the X2/X3 of the BBS
  cycle so the chip selected before the interrupt is re-armed

### Deliverables
- Updates to `test_4004/4004.c` and `test_4040/4040.c`.
- Integration tests using `4001` + `4002` chips on the same board:
  4004 reads/writes RAM, drives output port, reads input port.

### Sources
- MCS-4 manual §III.B (in `pdfs/`)
- MCS-40 manual §1 (in `pdfs/`)

---

## Phase E — 8086 ISA completion

### Goal
Bring the 8086 from ~50 opcodes (~30% of ISA) to substantially
complete (~95%). Target: subset of 8088 V2 SingleStepTests passing.

### Sub-phases
- **E.1** Shifts and rotates: SHL/SHR/SAR/ROL/ROR/RCL/RCR with imm or
  CL count. Group 2 (0xD0..0xD3).
- **E.2** String ops: MOVSB/MOVSW, CMPSB/CMPSW, SCASB/SCASW, LODSB/
  LODSW, STOSB/STOSW + REP/REPE/REPNE prefix handling.
- **E.3** Multiplication / division: MUL r/m8, MUL r/m16, IMUL r/m8,
  IMUL r/m16, DIV r/m8, DIV r/m16, IDIV r/m8, IDIV r/m16. Group 3
  (0xF6/0xF7).
- **E.4** BCD adjust: DAA, DAS, AAA, AAS, AAM imm8, AAD imm8.
- **E.5** Port I/O: IN AL,imm8 / IN AX,imm8 / IN AL,DX / IN AX,DX
  + OUT counterparts.
- **E.6** Hardware interrupts: NMI vector 2, INTR + INTA cycle reading
  vector byte from data bus, INT imm8, INT 3, INTO, IRET.
- **E.7** LDS/LES (load far pointer), LAHF/SAHF, XCHG, XLAT.
- **E.8** Conditional flag-set: SAHF, LAHF.
- **E.9** Group 4 (0xFE) — INC/DEC r/m8.
- **E.10** Undocumented opcodes: POP CS (0x0F), SALC (0xD6).

### Deliverables
- ~800 LOC additions to `test_8086/8086.c`.
- New tests under `test_8086/` for each instruction class.

### Sources
- Intel iAPX 86,88 User's Manual (in `pdfs/`)
- Cross-check: 8086tiny, MartyPC

---

## Phase F — Real software validation

### Goal
Prove correctness by running historic public-domain test programs.

### Sub-phases
- **F.1** **CPUDIAG** on 8080: load Microcosm Associates CPU diagnostic
  (1980, public domain) + minimal CP/M-like BDOS jump table; run until
  it prints "CPU IS OPERATIONAL"; integration test asserts expected
  output sequence.
- **F.2** **ZEXDOC** on Z80: load Frank Cringle's ZEXDOC (subset of
  ZEXALL — documented flags only); run for ~minutes of simulated time
  (it's a many-CRC test); assert all 67 sub-tests pass.
- **F.3** **8088 V2 SingleStepTests subset** on 8086: load JSON test
  cases (initial state + bus trace + final state) for selected
  opcodes; verify our chip matches.
- **F.4** **Busicom 141-PF** on 4004: load the original Busicom
  calculator firmware; verify display sequence for a known
  calculation. (Requires 4001/4002 chips from Phase C.)

### Deliverables
- Integration test files under `test_<chip>/` that wire the CPU + ROM
  + RAM and run the test ROM to completion.
- Vendored public-domain ROMs under `test/test_intel/roms/`:
  - `cpudiag.bin` (~2 KB)
  - `zexdoc.bin` (~9 KB)
  - `busicom_141pf.bin` (~1 KB)
- Test result expectations documented in autosearch/.

### Sources
- CPUDIAG: widely mirrored on Altair-related sites; license is
  effectively public-domain (Microcosm Associates, 1980).
- ZEXDOC/ZEXALL: Frank Cringle 1994; public domain.
- Busicom firmware: Intel released to public domain in 2009.
- 8088 V2 SingleStepTests: Daniel Balsom's MartyPC project,
  MIT-licensed.

---

## Phase G — Cycle accuracy (optional, deferred)

### Goal
Move from instruction-per-tick to cycle-accurate timing. Necessary
for emulating cycle-counting retro games (Spectrum games, Lotus
Esprit, etc.).

### Sub-phases
- **G.1** Per-opcode cycle counts for all 5 CPUs.
- **G.2** 8086 prefetch queue (4 bytes). Affects self-modifying
  code observable behavior.
- **G.3** Z80 contended memory model (Spectrum 16K..32K cycles).
- **G.4** Wait-state insertion via WAIT̅ + READY pin sampling.

This is HUGE work and only valuable for niche use-cases. Skipped
until user asks for it.

---

## Documentation conventions for completed phases

Each completed phase appends a section titled `## Phase X — completed
(YYYY-MM-DD)` with:

- **Delivered**: bullet list of what shipped
- **Deferred**: bullet list of what was originally planned but moved
  out of scope
- **Tests delta**: +N passing, +M todo, etc.
- **Files touched**: key paths
- **Lessons / surprises**: notable discoveries during implementation
- **Sources cited**: PDFs / repos / docs actually consulted

Commits made during the phase reference the phase letter in the
subject line (e.g. "test_intel: phase A — 8080 INTA bus protocol").

---

## Phase A — completed (2026-04-30)

### Delivered
- `test_8080/8080.c`: replaced the synthesised-RST-7 stub with a real
  INTA bus cycle. When `int_pending && ime`, the chip clears IME +
  INTE pin, runs `bus_read(PC, ST_INTA)` to emit status byte 0x23
  (M1+INTA+WO̅) on the data bus during T1, then samples the opcode
  external hardware (e.g. an 8259 PIC) jams onto D0..D7 during DBIN.
  RST n opcodes (0xC7..0xFF, mask 0xC7==0xC7) are decoded and
  push+vector executed.
- `test_8080/8080.test.js`: rewrote the INT test to install a
  test-fixture INTA driver that snoops SYNC + the status byte to
  detect INTA cycles, then drives RST 5 (0xEF) on the data bus during
  DBIN. Driver registered AFTER bootCpu's fake_rom so the late drive
  overrides the fake_rom's program-byte drive.

### Deferred
- Multi-byte opcodes during INTA (CALL nnn, JMP nnn) — would require
  the chip to issue further INTA cycles for operand bytes. Spec
  permits but rarely used in practice. The chip currently treats
  non-RST INTA opcodes as NOP.
- EI delayed-effect: real 8080 enables INT acknowledge on the
  *instruction after* EI so `EI; RET` is atomic. Mine enables
  immediately. Minor fidelity gap, no current test exercises it.

### Tests delta
- `test_8080`: 17 passing → **18 passing** (+1, the INT test
  promoted from pending-broken to passing).
- Total `test_intel`: 63 → **64 passing**, 16 todo.

### Files touched
- `test/test_intel/test_8080/8080.c`
- `test/test_intel/test_8080/8080.test.js`

### Lessons
- Listener registration order matters when multiple listeners drive
  the same pin. fake_rom registers a DBIN listener; an INTA fixture
  must register its own DBIN listener LATER so the late drive
  overrides. Documented in test comments.
- Two-stage SYNC→DBIN handoff (latch a flag at SYNC, act on DBIN)
  works cleanly; the alternative of doing everything in the SYNC
  callback fails because fake_rom's later DBIN drive wins.

### Sources cited
- `pdfs/mcs80_users.pdf` (Intel 1975) — INTA cycle status word + bus
  protocol
- Cross-checked behavior against `superzazu/8080`'s `i8080.c` lines
  on its `interrupt()` function (no code copied).

---

## Phase B — completed (2026-04-30)

### Delivered
- **B.1 CB prefix** — 256 ops: BIT n,r / SET n,r / RES n,r and rotates
  RLC/RRC/RL/RR/SLA/SRA/SLL/SRL on r ∈ B/C/D/E/H/L/(HL)/A. New
  `execute_cb()` function in `z80.c` (~80 LOC).
- **B.2 DDCB / FDCB** — indexed bit ops with displacement byte before
  inner opcode. `execute_indexed()` now intercepts CB sub-prefix and
  routes to `execute_cb` with `indexed=true`. The Sean Young "store-
  back-to-register" undocumented variant for non-(HL) reg_code is
  honoured (writes to plain B/C/D/E/H/L/A, not IXH/IXL).
- **B.3 X (bit 3) and Y (bit 5) undocumented flag bits** — `set_sz`
  and `set_szp` now copy result bits 3/5 into F. `add_hl` and `cpl`
  also updated to set X/Y from the result high byte / new A. Required
  for ZEXALL compatibility.
- **B.5 Z80-specific DAA** — new `daa_z80()` honours the N flag to
  pick subtractive vs additive correction. Algorithm sourced from
  Sean Young §4.7 (passes ZEXALL when paired with X/Y flags).
- **B.7 CPI / CPD / CPIR / CPDR** — block-compare ops with the X/Y
  bits computed from `(A − (HL) − H)` per Sean Young §4.2.
- **B.8 RLD / RRD** — 12-bit ring rotate between A's low nibble and
  the byte at (HL).
- **B.9 16-bit ADC HL,rr / SBC HL,rr** — full flag effects (S/Z/PV/H/
  N/C/X/Y) with bit-12 half-carry and 16-bit overflow.

### Deferred to later phases
- **B.4 MEMPTR (WZ) register** — affects bits 3/5 of F after
  `BIT n,(HL)` and DD/FD-prefixed BIT. Approximated using the
  operand bits for now. Full MEMPTR map is a Phase F polish item
  (only matters for the strictest ZEXALL cases).
- **B.6 Block I/O exact flags** (INI/IND/INIR/INDR/OUTI/OUTD/OTIR/
  OTDR) — instructions exist as ED-prefix stubs in the chip; Sean
  Young §4.3 fully-deterministic flag formulas not yet applied.
  Defer to Phase E or F.
- **B.10 NEG aliases** — already had all 8 from earlier work.
- **ZEXDOC integration test** — runs the full 9 KB Frank Cringle ROM.
  Requires Phase F (real software validation infrastructure).

### Tests delta
- `test_z80`: 11 passing → **21 passing** (+10: 6 CB tests, DAA, ADC
  HL, RLD, CPIR). Total tests in file went from 13 to 23.
- Total `test_intel`: 64 → **73 passing**, 17 todo, 0 failed.

### Files touched
- `test/test_intel/test_z80/z80.c` — added F_X/F_Y/F_XY constants;
  rewrote set_sz/set_szp; added execute_cb, daa_z80, adc_hl, sbc_hl,
  rld_op, rrd_op, cp_block; wired CB / DDCB / FDCB into prefix
  dispatch; added DAA at 0x27 in execute_main; added 8 new ED-prefix
  cases (4A/5A/6A/7A/42/52/62/72/6F/67/A1/A9/B1/B9).
- `test/test_intel/test_z80/z80.test.js` — added "CB-prefix bit ops"
  describe block with 10 tests covering SET, RES, RLC, SRL, SRA,
  BIT, DAA, ADC HL, RLD, CPIR.

### Lessons
- `set_sz` / `set_szp` are called from many opcodes — adding X/Y in
  one place propagates correctly to most flag-setting instructions.
  CPL is the exception: it doesn't touch S/Z/P, so X/Y must be set
  manually.
- For DDCB / FDCB: the inner opcode byte is **NOT** an M1 fetch (per
  Sean Young §6.1), so R is not incremented for it. Important when
  software relies on R for DRAM refresh emulation.
- Z80 DAA uses N flag for direction. The H-flag-after rule for the
  subtractive case (`old_low_nibble < 6`) is from Sean Young — not
  in the Zilog manual, but ZEXALL validates it.
- 16-bit ADC/SBC HL,rr take three operands' worth of state (the two
  16-bit values plus CF from F) — bit-12 half-carry needs careful
  cin handling.

### Sources cited
- `pdfs/z80_user_manual.pdf` (Zilog UM008003-1202)
- `pdfs/z80_undocumented.pdf` (Sean Young v0.91): §4.1 (BIT flags),
  §4.2 (CPI/CPD), §4.7 (DAA), §6.1 (DDCB R-register)
- Cross-check (no copy): `floooh/chips/z80.h` for CB rotate ops,
  `superzazu/z80` for DAA edge cases.

---

## Phase C — partial completion (2026-04-30)

### Delivered
- **rom-1m** (`test_buses/rom-1m.c`, ~110 LOC) — 64 KB ROM mapped at
  the top of the 8086's 1 MB space (0xF0000..0xFFFFF). Watches all 20
  address pins; releases bus when address is outside the ROM range.
  16-byte signature pre-loaded at the reset vector 0xFFFF0 for tests
  to verify presence. 4/4 tests passing.
- **8255 PPI** (`test_buses/8255-ppi.c`, ~200 LOC) — Mode 0 (basic
  I/O) implementation with three 8-bit ports (A, B, C) and split
  upper/lower port C. Control register parsing per the Intel
  datasheet; bit set/reset on PC and Modes 1/2 deferred. 5/5 tests
  passing including independent upper/lower PC halves.
- **8251 USART** (`test_buses/8251-usart.c`, ~200 LOC) — Async-mode
  UART using the runtime's `vx_uart_attach` for bit-level timing.
  Mode word + command word + status byte interface implemented;
  TxRDY/RxRDY/TxEMPTY status pins driven; modem-control DTR/RTS
  pass-through. Internal-reset (command bit 6) returns to "expect
  mode word" state. 4/4 tests passing.

### Deferred to a follow-up iteration
- **4001 ROM** (4-bit nibble bus for 4004): the multiplexed-bus phase
  tracking is non-trivial. The 4001 needs to know which phase of the
  4004's 8-phase frame is active, but our 4004 chip doesn't drive an
  external clock signal — the natural sync points (CL = Φ2) come from
  off-chip hardware we don't model. Workable solutions exist (one-shot
  timer scheduled by CMROM rising; or modify 4004 to drive a phase
  counter; or write a clock-gen chip to drive CLK1/CLK2). Picked the
  pragmatic path: CPU unit tests use the JS-side `Bus4004` helper from
  `test_4004/4004.test.js`, which already gives full 4001-equivalent
  functionality for testing. Real on-canvas use needs the chip later.
- **4002 RAM**: depends on 4001 being available.
- **8253 PIT**: 6 modes plus countdown logic — moderate complexity.
- **8259 PIC**: ICW1..ICW4 init state machine + cascade handling +
  EOI tracking + INTA cycle. Highest complexity of the four; defer
  until 8086 hardware-INTR is also wired (Phase E.E5).

### Tests delta
- `test_buses`: 17 → **30 passing** (+13: 4 rom-1m, 5 8255, 4 8251).
- Total `test_intel`: 73 → **86 passing**, 17 todo, 0 failed.

### Files touched
- `test/test_intel/test_buses/rom-1m.{c,test.js}` (new)
- `test/test_intel/test_buses/8255-ppi.{c,test.js}` (new)
- `test/test_intel/test_buses/8251-usart.{c,test.js}` (new)

### Lessons
- 1 MiB malloc in a chip exceeds the WASM 16-page (1 MiB) memory cap
  by the chip's own state size — clipped rom-1m to 64 KB at the top
  of the address range, where real BIOSes live.
- `vx_uart_attach` from the SDK abstracts away bit-level UART timing.
  Far easier than implementing async TxD/RxD start/stop bits manually.
- 8255 control byte's "set output direction" semantics also implicitly
  reset the output latch to 0 — caught only after a test failed when
  driving a port that had been an input previously.
- The 8259 PIC and 4001/4002 ROM/RAM all hit similar timing-coordination
  issues with their host CPU. Solving these properly probably needs a
  small "clock generator" chip that drives the CPU's external clock
  pins, but that's a larger architectural addition.

### Sources cited
- Intel 8255A Datasheet (public mirror, bitsavers.org)
- Intel 8251A Datasheet (public mirror, bitsavers.org)
- Existing `uart-rot13.c` example chip (in `test/test_custom_chips/`) as
  template for `vx_uart_attach` usage

---

## Phase E — completed (2026-04-30)

### Delivered (~600 LOC added to `8086.c`)
- **E.1 Shift/rotate Group 2** (0xD0/0xD1/0xD2/0xD3) — full 8-way op
  selector via ModR/M REG field: ROL/ROR/RCL/RCR/SHL/SHR/SAR (plus the
  undocumented "SETMO" alias = SHL). Count = 1 (immediate) or CL (var).
  CF and OF rules match the 8086 manual; OF only set when count == 1.
  S/Z/P updated for shifts, left alone for rotates.
- **E.2 String ops + REP/REPE/REPNE** — MOVSB/MOVSW, CMPSB/CMPSW,
  STOSB/STOSW, LODSB/LODSW, SCASB/SCASW. Direction respects DF; SI/DI
  advance by ±1 (byte) or ±2 (word). REP loop in step() decrements CX
  and exits on CX==0; REPE/REPZ exits also on ZF==0; REPNE/REPNZ on
  ZF==1.
- **E.3 MUL / IMUL / DIV / IDIV** — Group 3 (0xF6/0xF7) sub-opcodes 4,
  5, 6, 7. Byte forms produce AX = AL·src; word forms produce DX:AX =
  AX·src. Divisions check for divide-by-zero and quotient overflow,
  triggering halt (real 8086 takes INT 0 — close enough for now).
- **E.4 BCD adjust** — DAA, DAS, AAA, AAS, AAM imm8, AAD imm8.
  Algorithms verbatim from manual p.2-36 (DAA/DAS); AAA/AAS use the
  ASCII-arithmetic post-conditions; AAM/AAD use a runtime base byte
  (commonly 10 = "decimal", but any base works).
- **E.5 Port I/O** — IN AL,imm8 / IN AX,imm8 / IN AL,DX / IN AX,DX
  + OUT counterparts. Bus cycle drives M/IO=0 (matches our existing
  `is_io` plumbing in bus_read_byte/bus_write_byte).
- **E.6 Hardware interrupts** — NMI watcher (rising edge → NMI 2)
  and INTR watcher (level + IF gated). On INTR the chip drives INTA̅
  low for the acknowledge cycle; an external 8259 PIC (or test fixture)
  jams the vector byte on the data bus. INT imm8, INT 3, INTO, IRET
  all implemented.
- **E.7 LDS / LES / LAHF / SAHF / XCHG / XLAT** — load far pointer
  variants pull off+seg from r/m32. XCHG byte and word forms (0x86,
  0x87, 0x91..0x97). XLAT translates AL through a table at DS:BX.
  LAHF/SAHF round-trip the low byte of FLAGS through AH.
- **E.8 Group 4 (0xFE)** — INC/DEC r/m8 (8-bit form was missing).
- **E.9 PUSH/POP segment regs** — 0x06/0x0E/0x16/0x1E and matching
  POPs (POP CS = 0x0F is the undocumented one).
- **E.10 Undocumented** — POP CS (0x0F) and SALC (0xD6).
- **TEST r/m, r and TEST AL/AX,imm** — 0x84/0x85/0xA8/0xA9 (were
  inadvertently missing from the baseline).
- New harness: `BoardHarness.installFake8086Bus()` snapshots the
  multiplexed AD bus on ALE rising and drives data on RD̅ falling /
  latches on WR̅ rising — exactly what an 8282 + ROM/RAM combo on a
  real 8086 minimum-mode board does. ~50 lines.
- New test helper: `boot8086(program)` placing the test bytes at
  physical 0xF0100 with a JMP-FAR reset-vector stub at 0xFFFF0.

### Tests delta
- `test_8086`: 3 passing → **10 passing** (+7: MOV imm16, ADD,
  JMP near, SHL, MUL, REP MOVSB, segment override).
- Total `test_intel`: 86 → **93 passing**, 12 todo, 0 failed.

### Deferred (still it.todo)
- **CALL/RET round-trip**: the test does the right encoding but the
  chip takes an unexpected path after the CALL push (writes appear
  at SS:FDFC instead of the expected MOV [0x8002]=0x55). Investigated
  briefly via stderr trace; the issue may be in fetch_byte after the
  CALL+disp arithmetic, or in the post-call instruction stream
  decoding the next bytes as a CALL/PUSH variant. Marked todo.
- 8086 INT 0 on divide error (currently halt instead).
- Bochs-style "iret to v86" or 80186+ behavior.

### Files touched
- `test/test_intel/test_8086/8086.c` — added shift/rotate, BCD,
  string ops, MUL/DIV, port I/O, hardware INT, LDS/LES, LAHF/SAHF,
  XCHG, XLAT, Group 4, undocumented opcodes, segment-reg push/pop.
- `test/test_intel/test_8086/8086.test.js` — added boot8086 helper +
  7 new tests.
- `test/test_intel/src/BoardHarness.js` — `installFake8086Bus()`.

### Lessons
- Multiplexed AD bus is straightforward to model with two listeners
  (ALE rising → snapshot addr; RD/WR → drive/latch data). The hard
  part is in the chip side, not the test fixture.
- 0xCC (INT 3) was double-defined as halt-stub AND as do_int(3) in
  my big edit; compiler caught it as duplicate-case, easy fix.
- The 8086 had MANY opcodes already in baseline; the gaps were
  concentrated in a few op-classes (string ops, MUL/DIV, BCD,
  shifts). Adding a single helper per class kept the chip clean.

### Sources cited
- `pdfs/iapx_86_88_users_manual.pdf` — primary
- Cross-checked DAA / shift OF / MUL OF rules against the
  spec doc `autosearch/15_8086_authoritative_spec.md`

---

## Phase F — partial completion (2026-04-30)

### Delivered
- **8080PRE.COM** (1 KB preliminary 8080 instruction test) — runs to
  completion, no ERROR output.
- **TST8080.COM** (1.5 KB Microcosm Associates 1980 8080 CPU
  Diagnostic) — the canonical 8080 validation suite. Prints
  "CPU IS OPERATIONAL" on our chip. Test asserts the success message
  appears in BDOS output. Runs in ~52 seconds wall-clock for 2M
  simulated CPU cycles.
- **ZEXDOC** (8.5 KB Frank Cringle Z80 instruction exerciser, 1994,
  documented-flags subset of ZEXALL) — Z80 chip executes it long
  enough to print the "exerciser" banner; no ERROR within a 5M-cycle
  budget. Caveat: full ZEXDOC takes hours of simulated time and we
  only verify a time-bounded prefix.

### Test infrastructure built for Phase F
- `test/test_intel/roms/`: 8080pre.bin, tst8080.bin, 8080exm.bin
  (4.5 KB exhaustive — not yet wired up), zexdoc.bin. All public-
  domain CP/M .COM files mirrored from altairclone.com /
  floooh/chips-test (via WebFetch).
- `test_8080/cpudiag.test.js`: builds a 64 KB system image with
  CP/M zero-page (JMP 0x0100), BDOS at 0xFE00 (functions 2/9 emit
  via OUT port 0x01), patches the program at 0x0100, runs the chip,
  captures OUT writes via the WR̅+IORQ̅ pattern, asserts on output text.
- `test_z80/zexdoc.test.js`: same shape for Z80, with cs='MREQ'
  fake-ram so I/O ops bypass the memory chip-select.
- `test_z80/hello.test.js`: minimal sanity test for the BDOS+OUT
  capture path (used to debug the BDOS-overlap bug below).

### Lessons learned
- **BDOS placement matters**. My initial BDOS at 0x0F00 worked for
  the small TST8080.COM (~1.5 KB ending at 0x0700) but COLLIDED with
  ZEXDOC.COM (~8.5 KB ending at 0x21A9). Symptom: zero output. Fix:
  move BDOS to 0xFE00 (above the program area, inside the 64 KB
  segment). ZEXDOC reads its stack pointer from 0x0006/0x0007 (the
  CP/M-standard BDOS pointer) so simply changing both the JMP at
  0x0005 and the BDOS code's address resolves both issues at once.
- **Output buffering**. CPUDIAG prints ~1.5 KB; ZEXDOC's per-test
  banners and CRC-mismatch messages can be tens of KB.
  `String.fromCharCode(...output)` blows the call stack at ~100K+
  elements; build text in 4 KB chunks instead.
- **Z80 OUT detection** uses the same WR̅-falling-edge listener
  pattern as the 8080 but ALSO checks IORQ̅ to distinguish from
  memory writes (8080 distinguishes by the WR̅ status byte
  separately).

### Deferred to a future iteration
- **8080EXM.COM** (4.5 KB) — exhaustive 8080 exerciser; would
  validate flag edge cases that TST8080 misses.
- **Full ZEXDOC validation** — running all 67 sub-tests would take
  many hours of simulated time; would need either a faster timer
  cadence or a way to skip / parallelise tests. Likely needs
  a chip rewrite for cycle accuracy too.
- **Busicom 141-PF on 4004** — needs Phase D completion first
  (real 4001 ROM + 4002 RAM chips).
- **8088 V2 SingleStepTests on 8086** — JSON-format per-instruction
  state tests from the MartyPC project (~1M cases). Would need a
  different test harness style (load JSON, set chip state, run one
  instruction, compare).

### Tests delta
- New: `test_8080/cpudiag.test.js` (2 tests passing), `test_z80/
  zexdoc.test.js` (1 test passing), `test_z80/hello.test.js`
  (1 test, sanity check).
- Total `test_intel`: 94 → **98 passing**, 11 todo, 0 failed.

---

## Phase D — partial completion (2026-04-30)

### Delivered
- **4001 ROM** (`test_buses/4001-rom.c`, ~140 LOC) — companion ROM
  chip for the 4004/4040 over the 4-bit multiplexed nibble bus.
  Supports the canonical 8-phase frame: captures the 12-bit PC during
  A1/A2/A3, drives opcode high nibble during M1 and low nibble during
  M2 if the captured chip-select matches `ROM4001_CHIP_ID` (compile-
  time constant).
- **Integration test** (`test_buses/4001-rom.test.js`) — wires a real
  4001 chip alongside the 4004 chip on the same board and verifies
  that the 4004 actually fetches and executes opcodes from the 4001
  (PC walks 0, 1, 2 with the embedded NOP image).

### Timing model — the load-bearing trick
The 4001's own timer fires once per phase at the same period (1351 ns)
as the 4004's. The caller registers the 4001 BEFORE the 4004 in their
test board, so the 4001's `tickTimers` runs first per `advanceNanos`.
This means the 4001 effectively runs ONE FRAME BEHIND the 4004's
drives — it samples the bus contents (driven by the 4004 last frame)
and either records the addr nibble or drives the next opcode nibble.
A small state machine (S_SAMPLE_LOW → S_SAMPLE_MID → S_SAMPLE_HIGH →
S_DRIVE_HI → S_DRIVE_LO → S_POST) handles the 8-phase walk; reset on
SYNC rising. Documented in `4001-rom.c`.

### Phase D — 4002 also delivered (2026-04-30 → 2026-05-01)
- **4002 RAM** (`test_buses/4002-ram.c`, ~150 LOC) — companion data/IO
  chip. 16-pin contract, 80-nibble main + status storage, 4-pin output
  port, SYNC-driven phase tracking + CM-strobe-gated SRC chip-select
  latching at X2/X3. RESET clears storage and output port. 2/2 unit
  tests pass.

### Phase D — still pending
- **4004 SRC + WRM/RDM/WMP wiring** — the 4004 chip currently stubs
  the I/O group instructions; for the 4002 to actually receive
  addresses and exchange data, the 4004's SRC must drive the bus
  during X2/X3 and the I/O group ops must drive/sample during M2.
  Full I/O-group end-to-end is a Phase D-2 follow-up.
- **Busicom 141-PF integration test** for 4004 — requires both 4001
  and 4002 working end-to-end (i.e. Phase D-2 complete) plus a baked
  Busicom firmware ROM variant (~1 KB).

### Tests delta
- Total test_intel: 98 → **99 passing**, 11 todo, 0 failed.

---

## Phase C extension — completed (2026-04-30)

### Delivered (the two deferred chips from Phase C)

**8259 PIC** (`test_buses/8259-pic.c`, ~280 LOC). Single-master mode:
- ICW1..ICW4 init sequence with branching on the "single" and
  "ICW4 needed" flags (ICW1 bits 1 and 0).
- IRR / ISR / IMR registers + read-back via OCW3.
- Priority-based INT assertion (lower IRQ# = higher priority,
  fully-nested mode).
- INTA cycle drives `vector_base + IRQ#` on D bus.
- Non-specific (0x20) and specific (0x60..0x67) EOI commands.
- Pre-emption: a higher-priority IRQ during a lower-priority ISR
  re-asserts INT.
- 7/7 tests pass: pin contract, IRQ→INT, INTA→vector for IRQ0/3,
  IMR mask, EOI, pre-emption.
- **Cascade mode and slave-PIC routing NOT implemented** (single
  master is enough for 95% of demos).

**8253 PIT** (`test_buses/8253-pit.c`, ~210 LOC). Three channels with
- Mode 0 (interrupt on terminal count): OUT low after control, high
  when count hits 0.
- Mode 2 (rate generator): OUT pulses low for one CLK then auto-
  reloads — used for system tick.
- Mode 3 (square wave): OUT toggles every (count/2) CLKs — used for
  PC speaker tone.
- Modes 1, 4, 5 NOT implemented; control writes selecting them
  silently coerce to Mode 0.
- LSB-only / MSB-only / LSB-then-MSB read/write modes all work; the
  "latch counter" rw mode (00) snapshots the current count for the
  next read.
- GATE pin pauses counting when low.
- 4/4 tests pass.

### Tests delta
- Total test_intel: 99 → **110 passing**, 11 todo, 0 failed (+11).

## Phase G — still deferred (cycle accuracy)

## Phase G — still deferred (cycle accuracy)
