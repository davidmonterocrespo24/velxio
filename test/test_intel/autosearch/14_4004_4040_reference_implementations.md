# Intel 4004 / 4040 — Permissive Reference Emulators

License vetting performed against the GitHub `license` field via API on 2026‑04‑29.
**Excluded** (GPL/copyleft): MAME `mame/src/devices/cpu/mcs40/mcs40.cpp` (GPL‑2.0+); `carlini/intel-4004-in-4004-bytes-of-c` (GPL‑3.0). The user-suggested `lkesteloot/intel-4004` returns 404 — does not exist.

## Candidates (all SPDX MIT or equivalent)

### 1. **markablov/i40xx** — https://github.com/markablov/i40xx
- **License**: MIT (verified via API; LICENSE file in `packages/i40xx-emu`).
- **Language**: JavaScript (Node, ESM). 18 ★.
- **Coverage**: 4004 *and* 4040 in one core.
- **Core file**: `packages/i40xx-emu/src/cpu/cpu.js` — **~600 LOC** (19,551 bytes). Pin map in `pins.js` (44 LOC). Companion packages: assembler (`i40xx-asm`), linker, preprocess, an ICE-like UI, and a `pi-digits` program demo.
- **Tests**: `i40xx-program-pi-digits` package serves as integration smoke test (computes π via the 4040). No Busicom 141‑PF in-repo.

### 2. **Kostu96/K4004** — https://github.com/Kostu96/K4004
- **License**: MIT (root LICENSE).
- **Language**: C++17. 4 ★.
- **Coverage**: separate `K4004.cpp`/`K4040.cpp` cores with a shared `instructions.cpp`.
- **Core LOC**: K4004.cpp 3,654 B (~140 LOC), K4040.cpp 2,956 B, instructions.cpp 7,593 B (~280 LOC).
- **Tests**: `emulator_core/tests/instructions_tests.cpp` (11.7 KB of GoogleTest cases). **Includes Busicom 141‑PF**: `programs/busicom/busicom_141-PF.obj` (3,846 B object) + 122 KB disassembly. Note `programs/busicom/LICENSE.md` carries its own (Busicom-firmware) license — separate from the emulator's MIT.
- **Verdict**: best single repo to cross-validate against — has both cores and Busicom.

### 3. **lpg2709/emulator-Intel-4004** — https://github.com/lpg2709/emulator-Intel-4004
- **License**: MIT. 67 ★.
- **Language**: C99, single-file core `src/4004_chip.c` (9,762 B, ~360 LOC) + `4004_chip.h`. Built-in disassembler/assembler.
- **Tests**: dedicated `test/` dir; ROMs in `roms/`. Uses Zig build (`build.zig`). No 4040.

### 4. **alshapton/Pyntel4004** — https://github.com/alshapton/Pyntel4004
- **License**: MIT. Python. Has docs site (pyntel4004.readthedocs.io) and a `test/` dir.
- **Coverage**: 4004 only. Useful as a *spec-style* reference because each opcode is its own well-commented Python file.

### 5. **markablov/js-4004** — duplicate redirect of i40xx (same repo metadata returned).

## Tricky points — cross-checked against [M4]/[M40] and the implementations above

**(α) JMS/JUN encoding** — `0101 AAAA` `AAAA AAAA` for JMS, `0100 AAAA` `AAAA AAAA` for JUN. The **high 4 bits of the 12-bit target are in the LOW nibble of the first byte (the OPA)**, the low 8 bits are the second byte. **Confirmed** by [M4] Table V p. 16 (OPA = `A3 A3 A3 A3` followed by `A2 A2 A2 A2 A1 A1 A1 A1`) and by `i40xx/cpu.js` and `K4004/instructions.cpp`. No disagreement.

**(β) FIM encoding** — `0010 RRR0` + 1 immediate byte → 8‑bit immediate to register pair P (RRR encodes one of 8 pairs; LSB=0 distinguishes from SRC `0010 RRR1`). **Confirmed** by [M4] Table V p. 16. So FIM P0 = 0x20, FIM P1 = 0x22, … FIM P7 = 0x2E.

**(γ) ADD with carry** — [M4] p. 25 verbatim: *"(RRRR) + (ACC) + (CY) → ACC, CY"*. CY is an input. After the op CY = 1 if `sum > 15`. Index register unchanged. Implementations agree. SUB is `~Rn + ACC + ~CY` (one's-complement form per [M4] p. 26) — i.e. CY=0 means borrow-in, CY=1 means no borrow-in; on result, CY=0 = borrow generated, CY=1 = no borrow. Note this is **inverted** vs 8080 borrow polarity — emulator authors get this wrong frequently.

**(δ) DAA** — opcode **`1111 1011` = 0xFB** ([M4] p. 31, [I] cross-check). Verbatim: *"The accumulator is incremented by 6 if either the carry/link is 1 or if the accumulator content is greater than 9. The carry/link is set to a 1 if the result generates a carry, otherwise it is unaffected."* This **differs from 8080's DAA** in two ways: (i) it acts on a single 4-bit nibble (no high/low nibble split), so there's no auxiliary-carry concept; (ii) **CY is sticky** — only set, never cleared (8080's also has this property, but only after step 2). No half-carry flag exists.

## Recommendation

For Velxio, port the instruction-decode skeleton from **markablov/i40xx** (single core covers both chips, MIT, smallest to read) and validate cycle-accurate behaviour against **Kostu96/K4004**'s Busicom 141‑PF run — that's the canonical Intel 4004 acceptance test (the chip was originally built for it).

## Open questions

- Has **anyone** published a cycle-by-cycle JCN/ISZ trace test? Neither i40xx nor K4004 ships one. Would have to be derived from [M4] §VII descriptions.
- Whether `K4004`'s 4040 implements the **3-cycle DB0/DB1 inhibit window** correctly — needs source inspection.
- Pyntel4004 imports `pyntel4004` from PyPI; its tests cover instruction decode but not pin-level timing.
