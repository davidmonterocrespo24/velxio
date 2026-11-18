"""Tiny two-pass 8080 assembler.

Just enough to assemble the bundled-chip ROM monitors that ship with
Velxio's i8080-repl / i8080-counter custom chips. Not a full assembler:
no macros, no expressions, no LO/HI operators. Plain labels and
immediates only. Outputs a Python literal byte list which we paste
straight into the .c chip ROM table.

Usage: python asm8080.py <input.s> > rom.txt
"""
from __future__ import annotations

import re
import sys


# Tables driven by Intel opcode prefixes. Each entry maps to (size, encoder).
REG = {'B': 0, 'C': 1, 'D': 2, 'E': 3, 'H': 4, 'L': 5, 'M': 6, 'A': 7}
RP  = {'B': 0, 'D': 1, 'H': 2, 'SP': 3, 'PSW': 3}   # PSW only valid for PUSH/POP

# The 8080 addresses 64 KB: no location, and no byte, lies past it.
ADDRESS_SPACE = 0x10000
PAST_END = "the program does not fit the 64 KB address space (0x0000-0xFFFF)"


def _atom(tok: str, labels: dict[str, int]) -> int:
    if tok.startswith("'") and tok.endswith("'") and len(tok) == 3:
        return ord(tok[1])
    if tok in labels:
        return labels[tok]
    if tok.startswith('0x') or tok.startswith('0X'):
        return int(tok, 16)
    if tok.endswith('h') or tok.endswith('H'):
        return int(tok[:-1], 16)
    if tok.lstrip('-').isdigit():
        return int(tok)
    raise ValueError(f"can't parse atom {tok!r}")


def parse_imm(tok: str, labels: dict[str, int]) -> int:
    tok = tok.strip().rstrip(',').strip()
    # Support simple addition/subtraction of two atoms (e.g. "'Z'+1", "'A'-10").
    # Don't split inside a char literal.
    for op_char, sign in [('+', 1), ('-', -1)]:
        # Find op outside char/string literal.
        in_q = False
        for i, ch in enumerate(tok):
            if ch == "'":
                in_q = not in_q
            elif ch == op_char and not in_q and i > 0:
                left = tok[:i].strip()
                right = tok[i + 1:].strip()
                return _atom(left, labels) + sign * _atom(right, labels)
    return _atom(tok, labels)


def imm16(val: int) -> tuple[int, int]:
    val &= 0xFFFF
    return (val & 0xFF, (val >> 8) & 0xFF)


def _org_target(args: list[str], labels: dict[str, int]) -> int:
    if not args:
        raise ValueError("ORG needs an address")
    new = parse_imm(args[0], labels)
    if not 0 <= new <= ADDRESS_SPACE:  # 0x10000: the end, where nothing more goes
        raise ValueError(f"ORG {args[0][:40]} is outside the 64 KB address space (0x0000-0xFFFF)")
    return new


def assemble(src: str) -> bytes:
    # Strip comments + split into (label, mnemonic, args) tuples.
    raw_lines = []
    for ln in src.splitlines():
        ln = ln.split(';', 1)[0].rstrip()
        if not ln.strip():
            continue
        label = None
        # Find the first ':' that's outside a string literal.
        in_str = False
        colon = -1
        for i, ch in enumerate(ln):
            if ch == '"':
                in_str = not in_str
            elif ch == ':' and not in_str:
                colon = i; break
        if colon >= 0:
            label = ln[:colon].strip()
            ln = ln[colon + 1:]
        ln = ln.strip()
        if not ln:
            raw_lines.append((label, None, []))
            continue
        m = re.match(r'\s*(\S+)\s*(.*)$', ln)
        mnem = m.group(1).upper()
        args_raw = m.group(2).strip()
        args = [a.strip() for a in args_raw.split(',')] if args_raw else []
        raw_lines.append((label, mnem, args))

    # Pass 1: size and labels (with a fake label table; immediates that look
    # like labels get resolved in pass 2).
    sizes = []
    labels: dict[str, int] = {}
    pc = 0
    for (label, mnem, args) in raw_lines:
        if pc > ADDRESS_SPACE:
            raise ValueError(PAST_END)
        if label:
            labels[label] = pc
        if mnem is None:
            sizes.append(0); continue
        if mnem == 'ORG':
            new = _org_target(args, labels)
            # pad to new pc — but our ROM starts at 0 and ORG is only used
            # before any code, so this is a hard set, not a pad.
            pc = new
            sizes.append(0)
            continue
        if mnem == 'DB':
            n = 0
            for a in args:
                if a.startswith('"'):
                    n += len(bytes(a[1:-1], 'utf-8').decode('unicode_escape'))
                else:
                    n += 1
            sizes.append(n)
            pc += n
            continue
        if mnem == 'DW':
            sizes.append(2 * len(args)); pc += 2 * len(args); continue
        size = INSTR_SIZE.get(mnem)
        if size is None:
            raise ValueError(f"unknown mnemonic {mnem}")
        sizes.append(size); pc += size
    if pc > ADDRESS_SPACE:
        raise ValueError(PAST_END)

    # Pass 2: emit.
    out = bytearray()
    out_pc = 0
    # Track an explicit ORG pad
    org_pad_target: int | None = None
    for (idx, (label, mnem, args)) in enumerate(raw_lines):
        if out_pc > ADDRESS_SPACE:
            raise ValueError(PAST_END)
        if mnem == 'ORG':
            tgt = _org_target(args, labels)
            if tgt < out_pc:
                raise ValueError(f"ORG cannot move backwards (at {out_pc} -> {tgt})")
            out.extend(bytes(tgt - out_pc)); out_pc = tgt
            continue
        if mnem is None:
            continue
        if mnem == 'DB':
            for a in args:
                if a.startswith('"'):
                    raw_bytes = bytes(a[1:-1], 'utf-8').decode('unicode_escape').encode('latin1')
                    out.extend(raw_bytes); out_pc += len(raw_bytes)
                else:
                    v = parse_imm(a, labels) & 0xFF
                    out.append(v); out_pc += 1
            continue
        if mnem == 'DW':
            for a in args:
                lo, hi = imm16(parse_imm(a, labels))
                out.append(lo); out.append(hi); out_pc += 2
            continue
        emit = INSTR_ENCODE[mnem]
        bs = emit(args, labels)
        out.extend(bs); out_pc += len(bs)
    if out_pc > ADDRESS_SPACE:
        raise ValueError(PAST_END)

    return bytes(out)


# ── Encoders for the small subset of instructions our ROMs use ──────────────

def e_simple(opc):  return lambda a, l: bytes([opc])
def e_imm(opc):     return lambda a, l: bytes([opc, parse_imm(a[0], l) & 0xFF])
def e_addr(opc):    return lambda a, l: bytes([opc, *imm16(parse_imm(a[0], l))])

def e_mov(a, l):
    d = REG[a[0].upper()]; s = REG[a[1].upper()]
    return bytes([0x40 | (d << 3) | s])

def e_mvi(a, l):
    d = REG[a[0].upper()]
    return bytes([0x06 | (d << 3), parse_imm(a[1], l) & 0xFF])

def e_lxi(a, l):
    rp = RP[a[0].upper()]
    lo, hi = imm16(parse_imm(a[1], l))
    return bytes([0x01 | (rp << 4), lo, hi])

def e_alu_r(base):
    # ADD/SUB/etc r form
    return lambda a, l: bytes([base | REG[a[0].upper()]])

def e_inr(a, l):  return bytes([0x04 | (REG[a[0].upper()] << 3)])
def e_dcr(a, l):  return bytes([0x05 | (REG[a[0].upper()] << 3)])

def e_push(a, l): return bytes([0xC5 | (RP[a[0].upper()] << 4)])
def e_pop(a, l):  return bytes([0xC1 | (RP[a[0].upper()] << 4)])
def e_inx(a, l):  return bytes([0x03 | (RP[a[0].upper()] << 4)])
def e_dcx(a, l):  return bytes([0x0B | (RP[a[0].upper()] << 4)])
def e_dad(a, l):  return bytes([0x09 | (RP[a[0].upper()] << 4)])

INSTR_SIZE = {}
INSTR_ENCODE = {}

def _reg(name, size, fn):
    INSTR_SIZE[name] = size
    INSTR_ENCODE[name] = fn

# 1-byte simple
for n, opc in [('NOP', 0x00), ('HLT', 0x76), ('RET', 0xC9), ('XCHG', 0xEB),
               ('XTHL', 0xE3), ('SPHL', 0xF9), ('PCHL', 0xE9), ('EI', 0xFB),
               ('DI', 0xF3), ('CMA', 0x2F), ('STC', 0x37), ('CMC', 0x3F),
               ('RLC', 0x07), ('RRC', 0x0F), ('RAL', 0x17), ('RAR', 0x1F),
               ('DAA', 0x27), ('RNZ', 0xC0), ('RZ', 0xC8), ('RNC', 0xD0),
               ('RC', 0xD8), ('RPO', 0xE0), ('RPE', 0xE8), ('RP', 0xF0),
               ('RM', 0xF8)]:
    _reg(n, 1, e_simple(opc))

# 2-byte immediate
for n, opc in [('ADI', 0xC6), ('ACI', 0xCE), ('SUI', 0xD6), ('SBI', 0xDE),
               ('ANI', 0xE6), ('XRI', 0xEE), ('ORI', 0xF6), ('CPI', 0xFE),
               ('IN',  0xDB), ('OUT', 0xD3)]:
    _reg(n, 2, e_imm(opc))

# 3-byte address
for n, opc in [('JMP', 0xC3), ('JNZ', 0xC2), ('JZ', 0xCA), ('JNC', 0xD2),
               ('JC',  0xDA), ('JPO', 0xE2), ('JPE', 0xEA), ('JP', 0xF2),
               ('JM',  0xFA), ('CALL', 0xCD), ('CNZ', 0xC4), ('CZ', 0xCC),
               ('CNC', 0xD4), ('CC', 0xDC), ('CPO', 0xE4), ('CPE', 0xEC),
               ('CP',  0xF4), ('CM', 0xFC), ('LDA', 0x3A), ('STA', 0x32),
               ('LHLD', 0x2A), ('SHLD', 0x22)]:
    _reg(n, 3, e_addr(opc))

# MOV/MVI/LXI
_reg('MOV', 1, e_mov)
_reg('MVI', 2, e_mvi)
_reg('LXI', 3, e_lxi)

# ALU r-form (8 variants)
for n, base in [('ADD', 0x80), ('ADC', 0x88), ('SUB', 0x90), ('SBB', 0x98),
                ('ANA', 0xA0), ('XRA', 0xA8), ('ORA', 0xB0), ('CMP', 0xB8)]:
    _reg(n, 1, e_alu_r(base))

_reg('INR', 1, e_inr); _reg('DCR', 1, e_dcr)
_reg('PUSH', 1, e_push); _reg('POP', 1, e_pop)
_reg('INX', 1, e_inx); _reg('DCX', 1, e_dcx); _reg('DAD', 1, e_dad)

# LDAX/STAX (rp = B or D only)
def e_ldax(a, l):
    return bytes([{'B':0x0A,'D':0x1A}[a[0].upper()]])
def e_stax(a, l):
    return bytes([{'B':0x02,'D':0x12}[a[0].upper()]])
_reg('LDAX', 1, e_ldax); _reg('STAX', 1, e_stax)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("usage: asm8080.py <input.s>", file=sys.stderr); sys.exit(2)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        src = f.read()
    rom = assemble(src)
    # Emit as a C byte array
    print(f"// {len(rom)} bytes")
    cols = 12
    print("static const uint8_t ROM[] = {")
    for i in range(0, len(rom), cols):
        chunk = ', '.join(f'0x{b:02x}' for b in rom[i:i+cols])
        print(f"    {chunk},")
    print("};")
