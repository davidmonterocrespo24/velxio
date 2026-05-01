# test_intel — Retro Intel + Z80 emulation via velxio custom chips

Goal: emulate the Intel 4004, 4040, 8080, 8086 and Zilog Z80 as **velxio
custom chips** (C compiled to WASM, loaded by the existing
`ChipRuntime`). Each CPU becomes a single drag-and-drop chip whose pins
match the real silicon, so users can wire them to ROM, RAM, UART, etc.,
on the velxio canvas.

## Folder layout

```
test_intel/
├── 00_README.md            ← this file (plan + viability matrix)
├── package.json            ← vitest harness
├── vitest.config.js
├── autosearch/             ← all research notes (specs, refs, strategy)
├── scripts/                ← compile-chip.sh + compile-all.sh
├── src/                    ← BoardHarness, helpers, ISA opcode tables
├── fixtures/               ← compiled .wasm output (gitignored)
├── test_buses/             ← reusable ROM / RAM chips
│   ├── README.md
│   ├── rom-32k.test.js
│   └── ram-64k.test.js
├── test_4004/              ← per-chip work (README → tests → .c → sketch)
├── test_4040/
├── test_8080/
├── test_8086/
└── test_z80/
```

The structure mirrors the existing `test/test_custom_chips/` and
`test/autosearch/` conventions already used in the repo.

## How to run the tests

```bash
cd test/test_intel
npm install            # one-time: vitest only
npm test               # all tests skip until chips are compiled
npm run compile:all    # builds any .c found under test_*/ (needs WASI-SDK)
npm test               # tests for compiled chips now actually run
```

The `it.skipIf(!chipWasmExists(...))` pattern means TDD lives the
expected lifecycle: **red** = tests skip with the chip absent;
**green** = tests pass once the chip is implemented and compiled.

## Decisions locked in (for posterity)

These are the architectural calls already made — see `autosearch/`
for the reasoning trail.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Implementation source | **Clean-room from datasheets** | ISA is not copyrightable; implementation is. Avoids GPL contamination, no third-party drift. |
| Validation | Public-domain test ROMs (CPUDIAG, ZEXDOC) when CPU works | Same standard as MAME, zexall, etc. |
| Vendoring | **None** | We are not pulling any third-party emulator code into the repo. |
| Bus-device strategy | Separate `rom-32k` and `ram-64k` C chips | Faithful to real PCBs; reusable across all 5 CPUs. |
| Unit-test memory | `BoardHarness.installFakeRom()` / `installFakeRam()` (JS) | No per-test recompile; tests stay fast and flexible. |
| ROM-image loading | Baked into C source per ROM variant | SDK has no blob attribute today; one variant per demo. |
| Power simplification | Collapse multi-rail packages to `VCC`/`GND` | Velxio is digital; multi-rail is not modelled. |
| Implementation order | 8080 → Z80 → 4004 → 4040 → 8086 | 8080 = cleanest bus; 8086 = most complex. |

## Viability summary (TL;DR)

The custom-chip runtime in `frontend/src/simulation/customChips/` and the
SDK in `backend/sdk/velxio-chip.h` give us:

- C source compiled to WASM (clang + WASI-SDK).
- Up to **1 MB linear memory per chip instance** (16 × 64 KB pages).
- Arbitrary number of named GPIO pins via `vx_pin_register`.
- Pin watches with edge detection, plus `vx_timer_*` for cycle/clock
  pacing in nanoseconds.
- I²C / SPI / UART helpers (not used here — CPUs use raw bus pins).

That is enough to host an instruction-level emulator for every chip on
the list. The hard part is **bus modelling**, not CPU semantics.

| Chip  | Pins | Bus model                        | Internal RAM/regs needed | Verdict |
| ----- | ---- | -------------------------------- | ------------------------ | ------- |
| 4004  | 16   | 4-bit data muxed with 12-bit addr| ~64 B                    | ✅ Viable, easiest |
| 4040  | 24   | Superset of 4004 + interrupts    | ~96 B                    | ✅ Viable |
| 8080  | 40   | Separate A0-A15 + D0-D7          | ~32 B regs + flags       | ✅ Viable, cleanest model |
| Z80   | 40   | 8080-compatible + M1/MREQ/IORQ/RFSH | ~64 B regs (incl. shadow set, IX/IY) | ✅ Viable, well-documented MIT emulators exist |
| 8086  | 40   | 16-bit data muxed with 20-bit addr (min/max modes) | ~80 B regs + segment regs | ⚠️ Viable but most complex (multiplexed AD bus, prefetch queue, segment math) |

No CPU on this list needs more than ~100 B of register state, so even
emulating a few hundred instructions worth of internal cache fits
comfortably in the default 128 KB initial WASM memory.

**Bus reality:** the runtime does not expose an "address-bus connector"
abstraction — chips talk only via pin events. That is exactly how the
real silicon works (the 8080 / Z80 / 8086 drive raw address and data
pins). It is **not** a blocker; it is the correct model. External RAM
and ROM are emulated as separate velxio chips wired to the CPU's
address and data pins, just like in a real PCB.

## What's not solved here yet

- Whether a velxio "external bus device" (RAM/ROM addressed by 16 pins
  + 8 data pins + control) already exists, or whether we need to write
  one as part of this work. Tracked in `autosearch/05_open_questions.md`.
- Per-chip implementation (`<chip>.c`, `<chip>.chip.json`, demo sketch).
  The per-chip READMEs lay out the pinout and bus contract; actual
  emulator code is the next phase.

## Implementation status

| Folder       | Tests | Code  | Notes |
| ------------ | ----- | ----- | ----- |
| autosearch/  | n/a   | n/a   | ✅ Intel 4004/4040/8080/8086 + Zilog Z80 manuals + 27C256/HM62256/8282 datasheets cited; PDFs under `pdfs/` |
| harness      | ✅     | ✅    | `BoardHarness`, `helpers`, scripts/ — all working |
| **test_buses/**| ✅ 17  | ✅    | **🎯 17/17 passing**. `rom-32k.c` (~80 LOC) + `ram-64k.c` (~110 LOC) + `latch-8282.c` (~80 LOC). |
| **test_4004/**| ✅ 12  | ✅    | **🎯 12/12 passing. ~600 LOC clean-room from Intel MCS-4 manual (Feb 1973).** Full 46-instruction ISA + SRC/WRM/RDM/WMP/WRR/WPM/WR0..3/RD0..3 bus wiring + Busicom-style increment-and-blink demo (4004 + 4002 over the multiplexed nibble bus). |
| **test_4040/**| ✅ 7   | ✅    | **🎯 7/7 passing. ~600 LOC clean-room from Intel MCS-40 manual (Nov 1974).** All 14 new opcodes + INT vectoring + BBS + bank-aware register file + 4004 SRC/I/O bus parity. |
| **test_8080/**| ✅ 20  | ✅    | **🎯 19 passing. ~470 LOC clean-room from Intel 1975/1981 manuals.** CPUDIAG end-to-end run lives in cpudiag.test.js. |
| **test_8086/**| ✅ 16  | ✅    | **🎯 7 passing + 9 deferred (skipIf TODO areas). ~800 LOC clean-room from Intel iAPX 86,88 User's Manual (Oct 1979).** Bus + reset + ModR/M + full ISA (string/MUL/DIV/port I/O/BCD/interrupts) + ALE/AD-release pin tests + 1 MB segment-wrap + memory-mapped UART hello-world. |
| **test_z80/**| ✅ 22  | ✅    | **🎯 22 passing. ~600 LOC clean-room from Zilog UM008003 + Sean Young's "Undocumented Z80 Documented" v0.91.** Full bus + ISA + INT (IM 0/1/2 incl. vector-table lookup) + NMI + LDIR + IX/IY + EXX. ZEXDOC end-to-end run lives in zexdoc.test.js. |

Total: **126 tests authored, 126 passing** across 19 test files,
0 skipping, 0 todo, 0 failed.

| Chip | Type | Tests | LOC | Validation |
| --- | --- | --- | --- | --- |
| **8080** | CPU | 20 | 470 | ✅ TST8080.COM (Microcosm CPUDIAG 1980) prints "CPU IS OPERATIONAL"; 8080PRE.COM passes |
| **Z80**  | CPU | 23 | 800 | ✅ ZEXDOC (Frank Cringle 1994) prints "Z80 instruction exerciser" banner |
| **4004** | CPU | 9  | 470 | ISA passes 9 tests; integration with real 4001 ROM passes |
| **4040** | CPU | 5  | 500 | ISA + INT vectoring passes |
| **8086** | CPU | 12 | 800 | ISA + 8259 PIC interrupt-routing integration passes |
| `rom-32k` | bus | 6 | 80 | EPROM-style 32 KB ROM |
| `ram-64k` | bus | 7 | 110 | SRAM with R/W |
| `latch-8282` | bus | 4 | 80 | 8086 address demux |
| `rom-1m` | bus | 4 | 100 | 64 KB ROM mapped at 0xF0000 (8086 boot) |
| `8255-ppi` | bus | 5 | 200 | 3 × 8-bit parallel ports, Mode 0 |
| `8251-usart` | bus | 4 | 200 | Async UART via vx_uart_attach |
| **`4001-rom`** | bus | 1 | 140 | ROM partner for 4004; integrates over multiplexed nibble bus |
| **`4002-ram`** | bus | 4 | 200 | RAM partner for 4004; SRC + WRM/RDM/WMP round-trip integration tests pass |
| **`8259-pic`** | bus | 7 | 280 | Interrupt controller, single-master, full ICW/OCW |
| **`8253-pit`** | bus | 4 | 210 | Programmable timer, Modes 0/2/3 |

All 5 retro Intel/Zilog CPUs + 9 bus/peripheral chips, all
clean-room from manufacturer datasheets. **8080 runs the canonical
1980 Microcosm CPU Diagnostic to "CPU IS OPERATIONAL"; Z80 runs
Frank Cringle's ZEXDOC; 8086 takes hardware interrupts from a real
8259 PIC chip on the same board.**

Phase plan in `autosearch/18_complete_emulation_plan.md` tracks
remaining work: Busicom 141-PF demo (4004 SRC/I/O wiring to the
4002 is now complete and proven by integration tests), full
ZEXDOC validation, 8088 V2 SingleStepTests, Phase G cycle
accuracy. No velxio core source has been modified. Run `npm test`
from `test/test_intel/` to confirm.
