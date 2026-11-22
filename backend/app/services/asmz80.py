"""Two-pass Zilog Z80 assembler.

Covers the practical subset most LED / UART demos need:

  * Loads:        LD r,n  /  LD r,r'  /  LD rp,nn  /  LD (nn),A  /  LD A,(nn)
                  LD (nn),HL  /  LD HL,(nn)  /  LD A,(BC|DE)  /  LD (BC|DE),A
                  LD SP,HL
  * 8-bit ALU:    ADD/ADC/SUB/SBC/AND/XOR/OR/CP A,r and A,n
  * 8-bit unary:  INC r  /  DEC r
  * 16-bit:       INC rp  /  DEC rp  /  ADD HL,rp
  * Control:      JP nn / JP cc,nn / JR n / JR cc,n / DJNZ n
                  CALL nn / CALL cc,nn / RET / RET cc / RST n / NOP / HALT
  * Stack:        PUSH rp / POP rp
  * I/O:          IN A,(n) / OUT (n),A
  * Exchanges:    EX DE,HL / EX (SP),HL / EX AF,AF' / EXX
  * Interrupts:   DI / EI / IM 0|1|2 / RETI / RETN
  * Rotates:      RLCA / RRCA / RLA / RRA
  * Block:        LDI / LDIR / LDD / LDDR
  * Misc:         CPL / SCF / CCF / DAA / NEG

Not covered today: CB-prefix bit ops (BIT/SET/RES/RL/RR/SLA/SRA/SRL),
DD/FD-prefix IX/IY indexed addressing, ED-prefix variants beyond what is
listed. The chip emulator implements them; the assembler can be extended
when a demo needs them.

Output is a raw byte stream; the user adds `ORG`/labels/`DB`/`DW` in the
usual way. Used by `POST /api/compile-rom` with `target=z80`.
"""
from __future__ import annotations

import re

# ── Register tables (Z80 encoding) ────────────────────────────────────────
R8  = {'B': 0, 'C': 1, 'D': 2, 'E': 3, 'H': 4, 'L': 5, '(HL)': 6, 'A': 7}
RP  = {'BC': 0, 'DE': 1, 'HL': 2, 'SP': 3}
RP2 = {'BC': 0, 'DE': 1, 'HL': 2, 'AF': 3}   # used by PUSH/POP
CC  = {'NZ': 0, 'Z': 1, 'NC': 2, 'C': 3, 'PO': 4, 'PE': 5, 'P': 6, 'M': 7}
CC_REL = {'NZ': 0, 'Z': 1, 'NC': 2, 'C': 3}  # 8-bit-displacement relative branches

# The Z80 addresses 64 KB: no location, and no byte, lies past it.
ADDRESS_SPACE = 0x10000
PAST_END = "the program does not fit the 64 KB address space (0x0000-0xFFFF)"


def _atom(tok: str, labels: dict[str, int]) -> int:
    tok = tok.strip()
    if tok.startswith("'") and tok.endswith("'") and len(tok) == 3:
        return ord(tok[1])
    if tok in labels:
        return labels[tok]
    if tok.startswith('0x') or tok.startswith('0X'):
        return int(tok, 16)
    if tok.endswith('h') or tok.endswith('H'):
        return int(tok[:-1], 16)
    if tok.endswith('b') or tok.endswith('B'):
        return int(tok[:-1], 2)
    if tok.lstrip('-').isdigit():
        return int(tok)
    raise ValueError(f"asm-z80: can't parse {tok!r}")


def parse_imm(tok: str, labels: dict[str, int]) -> int:
    tok = tok.strip().rstrip(',').strip()
    # Tiny expression parser — supports a single + or - between two atoms,
    # ignoring operators that sit inside char literals.
    for op_char, sign in [('+', 1), ('-', -1)]:
        in_q = False
        for i, ch in enumerate(tok):
            if ch == "'":
                in_q = not in_q
            elif ch == op_char and not in_q and i > 0:
                return _atom(tok[:i], labels) + sign * _atom(tok[i + 1:], labels)
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


# ── Parsing helpers ───────────────────────────────────────────────────────
def _split_args(arg_str: str) -> list[str]:
    """Split on commas that aren't inside parens or char literals."""
    out: list[str] = []
    buf = ''
    depth = 0
    in_q = False
    for ch in arg_str:
        if ch == "'":
            in_q = not in_q
            buf += ch
        elif ch == '(' and not in_q:
            depth += 1; buf += ch
        elif ch == ')' and not in_q:
            depth -= 1; buf += ch
        elif ch == ',' and depth == 0 and not in_q:
            out.append(buf.strip())
            buf = ''
        else:
            buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


def _is_indirect(tok: str) -> bool:
    tok = tok.strip()
    return tok.startswith('(') and tok.endswith(')')


def _strip_paren(tok: str) -> str:
    return tok.strip()[1:-1].strip()


# ── Encoders ──────────────────────────────────────────────────────────────
def _enc_ld(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) != 2:
        raise ValueError(f"LD needs two operands, got {args}")
    dst, src = args[0].upper(), args[1].upper()

    # LD rp,nn  (BC/DE/HL/SP <- immediate)
    if dst in RP and not _is_indirect(src):
        opc = 0x01 | (RP[dst] << 4)
        lo, hi = imm16(parse_imm(src, labels))
        return bytes([opc, lo, hi])

    # LD (nn),A / LD (nn),HL
    if _is_indirect(dst):
        inner = _strip_paren(dst)
        if inner == 'BC' and src == 'A': return bytes([0x02])
        if inner == 'DE' and src == 'A': return bytes([0x12])
        if inner == 'HL':
            if src in R8 and src != '(HL)':
                return bytes([0x70 | R8[src]])
            # LD (HL),n
            lo, hi = imm16(parse_imm(src, labels))
            return bytes([0x36, lo])
        # LD (nn),A or (nn),HL
        lo, hi = imm16(parse_imm(inner, labels))
        if src == 'A':  return bytes([0x32, lo, hi])
        if src == 'HL': return bytes([0x22, lo, hi])
        if src == 'BC': return bytes([0xED, 0x43, lo, hi])
        if src == 'DE': return bytes([0xED, 0x53, lo, hi])
        if src == 'SP': return bytes([0xED, 0x73, lo, hi])
        raise ValueError(f"LD (nn),{src} not supported")

    # LD A,(BC) / LD A,(DE) / LD HL,(nn) / LD A,(nn)
    if _is_indirect(src):
        inner = _strip_paren(src)
        if dst == 'A' and inner == 'BC': return bytes([0x0A])
        if dst == 'A' and inner == 'DE': return bytes([0x1A])
        if dst in R8 and dst != '(HL)' and inner == 'HL':
            return bytes([0x46 | (R8[dst] << 3)])
        lo, hi = imm16(parse_imm(inner, labels))
        if dst == 'A':  return bytes([0x3A, lo, hi])
        if dst == 'HL': return bytes([0x2A, lo, hi])
        if dst == 'BC': return bytes([0xED, 0x4B, lo, hi])
        if dst == 'DE': return bytes([0xED, 0x5B, lo, hi])
        if dst == 'SP': return bytes([0xED, 0x7B, lo, hi])
        raise ValueError(f"LD {dst},({inner}) not supported")

    # LD SP,HL
    if dst == 'SP' and src == 'HL':
        return bytes([0xF9])

    # LD r,r'
    if dst in R8 and src in R8:
        if dst == '(HL)' and src == '(HL)':
            raise ValueError("LD (HL),(HL) is invalid (would be HALT)")
        return bytes([0x40 | (R8[dst] << 3) | R8[src]])

    # LD r,n
    if dst in R8:
        return bytes([0x06 | (R8[dst] << 3), parse_imm(src, labels) & 0xFF])

    # LD I,A / LD A,I / LD R,A / LD A,R
    if dst == 'I' and src == 'A': return bytes([0xED, 0x47])
    if dst == 'R' and src == 'A': return bytes([0xED, 0x4F])
    if dst == 'A' and src == 'I': return bytes([0xED, 0x57])
    if dst == 'A' and src == 'R': return bytes([0xED, 0x5F])

    raise ValueError(f"LD {dst},{src} not supported")


def _enc_alu(base8: int, immcode: int):
    """Build an encoder for an A,r / A,n ALU op.
    base8 is the 8-bit register-form base (e.g. 0x80 for ADD A,r).
    immcode is the 2-byte immediate-form opcode (e.g. 0xC6 for ADD A,n).
    """
    def enc(args: list[str], labels: dict[str, int]) -> bytes:
        # Z80 syntax is `ADD A,r` but plain `ADD r` is also accepted.
        if len(args) == 2 and args[0].upper() == 'A':
            args = [args[1]]
        if len(args) != 1:
            raise ValueError(f"ALU needs one operand (besides A), got {args}")
        tok = args[0].upper()
        if tok in R8:
            return bytes([base8 | R8[tok]])
        # Immediate
        return bytes([immcode, parse_imm(args[0], labels) & 0xFF])
    return enc


def _enc_inc_dec(is_inc: bool):
    def enc(args: list[str], labels: dict[str, int]) -> bytes:
        if len(args) != 1:
            raise ValueError("INC/DEC takes one operand")
        tok = args[0].upper()
        if tok in RP:
            base = 0x03 if is_inc else 0x0B
            return bytes([base | (RP[tok] << 4)])
        if tok in R8:
            base = 0x04 if is_inc else 0x05
            return bytes([base | (R8[tok] << 3)])
        raise ValueError(f"INC/DEC {tok!r} not supported")
    return enc


def _enc_push_pop(is_push: bool):
    def enc(args: list[str], labels: dict[str, int]) -> bytes:
        if len(args) != 1 or args[0].upper() not in RP2:
            raise ValueError(f"PUSH/POP needs BC/DE/HL/AF, got {args}")
        base = 0xC5 if is_push else 0xC1
        return bytes([base | (RP2[args[0].upper()] << 4)])
    return enc


def _enc_addhl(args: list[str], labels: dict[str, int]) -> bytes:
    # Accept ADD HL,rp.
    if len(args) == 2 and args[0].upper() == 'HL':
        rp = args[1].upper()
        if rp in RP:
            return bytes([0x09 | (RP[rp] << 4)])
    raise ValueError(f"ADD HL,rp expected, got {args}")


def _enc_jp(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 1:
        if args[0].upper() == '(HL)':
            return bytes([0xE9])
        lo, hi = imm16(parse_imm(args[0], labels))
        return bytes([0xC3, lo, hi])
    if len(args) == 2 and args[0].upper() in CC:
        lo, hi = imm16(parse_imm(args[1], labels))
        return bytes([0xC2 | (CC[args[0].upper()] << 3), lo, hi])
    raise ValueError(f"JP {args} not supported")


def _rel(addr_from_after_instr: int, target: int) -> int:
    delta = target - addr_from_after_instr
    if delta < -128 or delta > 127:
        raise ValueError(f"JR/DJNZ out of range: delta={delta}")
    return delta & 0xFF


def _enc_jr(pc_after, args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 1:
        tgt = parse_imm(args[0], labels)
        return bytes([0x18, _rel(pc_after, tgt)])
    if len(args) == 2 and args[0].upper() in CC_REL:
        tgt = parse_imm(args[1], labels)
        return bytes([0x20 | (CC_REL[args[0].upper()] << 3), _rel(pc_after, tgt)])
    raise ValueError(f"JR {args} not supported")


def _enc_djnz(pc_after, args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) != 1:
        raise ValueError(f"DJNZ takes one operand")
    tgt = parse_imm(args[0], labels)
    return bytes([0x10, _rel(pc_after, tgt)])


def _enc_call(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 1:
        lo, hi = imm16(parse_imm(args[0], labels))
        return bytes([0xCD, lo, hi])
    if len(args) == 2 and args[0].upper() in CC:
        lo, hi = imm16(parse_imm(args[1], labels))
        return bytes([0xC4 | (CC[args[0].upper()] << 3), lo, hi])
    raise ValueError(f"CALL {args} not supported")


def _enc_ret(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 0:
        return bytes([0xC9])
    if len(args) == 1 and args[0].upper() in CC:
        return bytes([0xC0 | (CC[args[0].upper()] << 3)])
    raise ValueError(f"RET {args} not supported")


def _enc_rst(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) != 1:
        raise ValueError("RST takes one operand")
    n = parse_imm(args[0], labels)
    if n not in (0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38):
        raise ValueError(f"RST {n:02x}h is not a legal vector")
    return bytes([0xC7 | n])


def _enc_in(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 2 and args[0].upper() == 'A' and _is_indirect(args[1]):
        return bytes([0xDB, parse_imm(_strip_paren(args[1]), labels) & 0xFF])
    raise ValueError(f"IN {args} not supported")


def _enc_out(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) == 2 and _is_indirect(args[0]) and args[1].upper() == 'A':
        return bytes([0xD3, parse_imm(_strip_paren(args[0]), labels) & 0xFF])
    raise ValueError(f"OUT {args} not supported")


def _enc_ex(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) != 2:
        raise ValueError("EX needs two operands")
    a, b = args[0].upper(), args[1].upper()
    if a == 'DE' and b == 'HL':       return bytes([0xEB])
    if a == 'AF' and b == "AF'":      return bytes([0x08])
    if a == "AF" and b == "AF'":      return bytes([0x08])
    if a == '(SP)' and b == 'HL':     return bytes([0xE3])
    raise ValueError(f"EX {args} not supported")


def _enc_im(args: list[str], labels: dict[str, int]) -> bytes:
    if len(args) != 1:
        raise ValueError("IM takes one operand")
    n = parse_imm(args[0], labels)
    return {0: bytes([0xED, 0x46]), 1: bytes([0xED, 0x56]), 2: bytes([0xED, 0x5E])}.get(n) or _bad(f"IM {n}")


def _bad(msg: str):
    raise ValueError(msg)


def _simple(opc: int):
    if isinstance(opc, int):
        return lambda a, l: bytes([opc])
    return lambda a, l: bytes(opc)


def _two(b0: int, b1: int):
    return lambda a, l: bytes([b0, b1])


# Build dispatch tables.
INSTR_SIZE: dict[str, int] = {}
INSTR_ENCODE: dict[str, callable] = {}   # type: ignore[type-arg]


def _reg(name: str, size: int, fn) -> None:
    INSTR_SIZE[name] = size
    INSTR_ENCODE[name] = fn


# ── Static (no operands) ─────────────────────────────────────────────────
_reg('NOP',   1, _simple(0x00))
_reg('HALT',  1, _simple(0x76))
_reg('CPL',   1, _simple(0x2F))
_reg('SCF',   1, _simple(0x37))
_reg('CCF',   1, _simple(0x3F))
_reg('DAA',   1, _simple(0x27))
_reg('RLCA',  1, _simple(0x07))
_reg('RRCA',  1, _simple(0x0F))
_reg('RLA',   1, _simple(0x17))
_reg('RRA',   1, _simple(0x1F))
_reg('DI',    1, _simple(0xF3))
_reg('EI',    1, _simple(0xFB))
_reg('EXX',   1, _simple(0xD9))
_reg('NEG',   2, _two(0xED, 0x44))
_reg('RETI',  2, _two(0xED, 0x4D))
_reg('RETN',  2, _two(0xED, 0x45))
_reg('LDI',   2, _two(0xED, 0xA0))
_reg('LDIR',  2, _two(0xED, 0xB0))
_reg('LDD',   2, _two(0xED, 0xA8))
_reg('LDDR',  2, _two(0xED, 0xB8))
_reg('CPI',   2, _two(0xED, 0xA1))
_reg('CPIR',  2, _two(0xED, 0xB1))

# ── ALU 8-bit ─────────────────────────────────────────────────────────────
def _reg_alu(name: str, base8: int, immcode: int) -> None:
    INSTR_ENCODE[name] = _enc_alu(base8, immcode)
    # Size depends on operand — set in pass 1 dynamically (see assemble()).

for n, base, imm in [('ADD', 0x80, 0xC6), ('ADC', 0x88, 0xCE),
                     ('SUB', 0x90, 0xD6), ('SBC', 0x98, 0xDE),
                     ('AND', 0xA0, 0xE6), ('XOR', 0xA8, 0xEE),
                     ('OR',  0xB0, 0xF6), ('CP',  0xB8, 0xFE)]:
    _reg_alu(n, base, imm)

INSTR_ENCODE['INC'] = _enc_inc_dec(True)
INSTR_ENCODE['DEC'] = _enc_inc_dec(False)
INSTR_ENCODE['LD']  = _enc_ld
INSTR_ENCODE['PUSH'] = _enc_push_pop(True)
INSTR_ENCODE['POP']  = _enc_push_pop(False)
INSTR_ENCODE['JP']   = _enc_jp
INSTR_ENCODE['CALL'] = _enc_call
INSTR_ENCODE['RET']  = _enc_ret
INSTR_ENCODE['RST']  = _enc_rst
INSTR_ENCODE['IN']   = _enc_in
INSTR_ENCODE['OUT']  = _enc_out
INSTR_ENCODE['EX']   = _enc_ex
INSTR_ENCODE['IM']   = _enc_im

# JR and DJNZ are PC-relative — they need pc_after to encode.
# Handled specially in the assemble() pass below.
INSTR_ENCODE['JR']   = '__JR__'      # sentinel
INSTR_ENCODE['DJNZ'] = '__DJNZ__'
INSTR_ENCODE['ADD']  = _enc_alu(0x80, 0xC6)


# ── Static-size table (used only when encoder doesn't depend on operand) ─
STATIC_SIZE = {
    'NOP': 1, 'HALT': 1, 'CPL': 1, 'SCF': 1, 'CCF': 1, 'DAA': 1,
    'RLCA': 1, 'RRCA': 1, 'RLA': 1, 'RRA': 1, 'DI': 1, 'EI': 1, 'EXX': 1,
    'NEG': 2, 'RETI': 2, 'RETN': 2, 'LDI': 2, 'LDIR': 2, 'LDD': 2,
    'LDDR': 2, 'CPI': 2, 'CPIR': 2,
    'RST': 1, 'JR': 2, 'DJNZ': 2, 'IM': 2,
    'IN':  2, 'OUT': 2,
    'PUSH': 1, 'POP': 1, 'INC': 1, 'DEC': 1, 'EX': 1,
}


def _size_for(mnem: str, args: list[str]) -> int:
    """Estimate the size of an instruction (pass 1) without resolving labels.
    Conservative — returns the LARGER of the possible encodings when in doubt
    so labels resolve to stable addresses.
    """
    if mnem in STATIC_SIZE:
        return STATIC_SIZE[mnem]
    if mnem == 'LD':
        # Distinguish LD r,r' (1) vs LD r,n (2) vs LD rp,nn (3) vs LD (nn),A (3 or 4)
        if len(args) != 2: return 1
        a, b = args[0].upper(), args[1].upper()
        if _is_indirect(a):
            inner = _strip_paren(a)
            if inner in ('BC', 'DE'):     return 1
            if inner == 'HL':
                if b in R8 and b != '(HL)': return 1
                return 2     # LD (HL),n
            # LD (nn),X
            if b in ('A',):                return 3
            if b == 'HL':                  return 3
            if b in ('BC', 'DE', 'SP'):    return 4
            return 3
        if _is_indirect(b):
            inner = _strip_paren(b)
            if inner in ('BC', 'DE'):     return 1
            if inner == 'HL':              return 1
            if a == 'A':                  return 3
            if a == 'HL':                 return 3
            if a in ('BC', 'DE', 'SP'):   return 4
            return 3
        if a in RP:                       return 3
        if a == 'SP' and b == 'HL':       return 1
        if a in R8 and b in R8:           return 1
        return 2                           # LD r,n
    if mnem in ('ADD', 'ADC', 'SUB', 'SBC', 'AND', 'XOR', 'OR', 'CP'):
        # `ADD HL,rp` is 1 byte, ALU A,r is 1, ALU A,n is 2.
        if mnem == 'ADD' and len(args) == 2 and args[0].upper() == 'HL':
            return 1
        # Strip leading "A," if present.
        if len(args) == 2 and args[0].upper() == 'A':
            args = [args[1]]
        if len(args) == 1 and args[0].upper() in R8: return 1
        return 2
    if mnem == 'JP':
        if len(args) == 1 and args[0].upper() == '(HL)': return 1
        return 3
    if mnem == 'CALL':
        return 3
    if mnem == 'RET':
        return 1
    raise ValueError(f"asm-z80 pass1: unknown mnemonic {mnem!r}")


def assemble(src: str) -> bytes:
    """Two-pass assembler: pass 1 sizes + labels, pass 2 emits."""
    # ── Tokenize ─────────────────────────────────────────────────────────
    lines: list[tuple[str | None, str | None, list[str]]] = []
    for raw in src.splitlines():
        text = raw.split(';', 1)[0].rstrip()
        if not text.strip():
            lines.append((None, None, [])); continue
        label = None
        # Find first ':' outside parens / quotes — same scheme as asm8080.
        in_q = False; depth = 0; colon = -1
        for i, ch in enumerate(text):
            if ch == "'": in_q = not in_q
            elif ch == '(': depth += 1
            elif ch == ')': depth = max(0, depth - 1)
            elif ch == ':' and not in_q and depth == 0:
                colon = i; break
        if colon >= 0:
            label = text[:colon].strip()
            text = text[colon + 1:]
        text = text.strip()
        if not text:
            lines.append((label, None, [])); continue
        m = re.match(r'\s*(\S+)\s*(.*)$', text)
        if not m:
            lines.append((label, None, [])); continue
        mnem = m.group(1).upper()
        args = _split_args(m.group(2).strip())
        lines.append((label, mnem, args))

    # ── Pass 1: estimate sizes + assign labels ───────────────────────────
    labels: dict[str, int] = {}
    sizes: list[int] = []
    pc = 0
    for (lbl, mnem, args) in lines:
        if pc > ADDRESS_SPACE:
            raise ValueError(PAST_END)
        if lbl:
            labels[lbl] = pc
        if mnem is None:
            sizes.append(0); continue
        if mnem == 'ORG':
            new_pc = _org_target(args, labels)
            if new_pc < pc:
                raise ValueError(f"ORG cannot move backwards (at {pc} -> {new_pc})")
            sizes.append(new_pc - pc); pc = new_pc; continue
        if mnem == 'DB':
            n = 0
            for a in args:
                if a.startswith('"') and a.endswith('"'):
                    n += len(bytes(a[1:-1], 'utf-8').decode('unicode_escape'))
                else:
                    n += 1
            sizes.append(n); pc += n; continue
        if mnem == 'DW':
            sizes.append(2 * len(args)); pc += 2 * len(args); continue
        sz = _size_for(mnem, args)
        sizes.append(sz); pc += sz
    if pc > ADDRESS_SPACE:
        raise ValueError(PAST_END)

    # ── Pass 2: emit ──────────────────────────────────────────────────────
    out = bytearray()
    pc = 0
    for (i, (lbl, mnem, args)) in enumerate(lines):
        if pc > ADDRESS_SPACE:
            raise ValueError(PAST_END)
        if mnem is None:
            continue
        if mnem == 'ORG':
            tgt = _org_target(args, labels)
            if tgt > pc:
                out.extend(bytes(tgt - pc)); pc = tgt
            continue
        if mnem == 'DB':
            for a in args:
                if a.startswith('"') and a.endswith('"'):
                    blob = bytes(a[1:-1], 'utf-8').decode('unicode_escape').encode('latin1')
                    out.extend(blob); pc += len(blob)
                else:
                    v = parse_imm(a, labels) & 0xFF
                    out.append(v); pc += 1
            continue
        if mnem == 'DW':
            for a in args:
                lo, hi = imm16(parse_imm(a, labels))
                out.append(lo); out.append(hi); pc += 2
            continue

        enc = INSTR_ENCODE.get(mnem)
        if enc is None:
            raise ValueError(f"asm-z80: unknown mnemonic {mnem!r}")

        # JR / DJNZ need pc_after (pc + size) for relative encoding.
        if enc == '__JR__':
            data = _enc_jr(pc + 2, args, labels)
        elif enc == '__DJNZ__':
            data = _enc_djnz(pc + 2, args, labels)
        elif mnem == 'ADD' and len(args) == 2 and args[0].upper() == 'HL':
            data = _enc_addhl(args, labels)
        else:
            data = enc(args, labels)
        out.extend(data); pc += len(data)
    if pc > ADDRESS_SPACE:
        raise ValueError(PAST_END)

    return bytes(out)


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('usage: asmz80.py <input.s>'); sys.exit(2)
    rom = assemble(open(sys.argv[1], encoding='utf-8').read())
    print(f"// {len(rom)} bytes")
    print('static const uint8_t ROM[] = {')
    for i in range(0, len(rom), 12):
        chunk = ', '.join(f'0x{b:02x}' for b in rom[i:i+12])
        print(f"    {chunk},")
    print('};')
