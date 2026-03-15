/**
 * RiscVSimulator — CH32V003-compatible RV32I simulator wrapper.
 *
 * Wraps RiscVCore with:
 * - requestAnimationFrame execution loop (~48 MHz @ 60 fps)
 * - CH32V003 MMIO: UART1 (0x40013800), GPIO A/C/D (0x40010800/0x40010C00/0x40011400)
 * - Intel HEX loader (flash @ 0x08000000, RAM @ 0x20000000)
 * - Serial I/O and pin-change callbacks matching AVRSimulator interface
 */

import { RiscVCore } from './RiscVCore';
import { PinManager } from './PinManager';
import { hexToUint8Array } from '../utils/hexParser';

// CH32V003 memory map
const FLASH_BASE = 0x08000000;
const RAM_BASE   = 0x20000000;
const FLASH_SIZE = 16 * 1024;   // 16 KB
const RAM_SIZE   =  2 * 1024;   //  2 KB

// Combined flat buffer: flash first, then RAM
const MEM_SIZE = FLASH_SIZE + RAM_SIZE;

// CH32V003 clock
const CPU_HZ = 48_000_000;
const CYCLES_PER_FRAME = Math.round(CPU_HZ / 60);

// ── CH32V003 UART1 MMIO (0x40013800) ────────────────────────────────────────
// STATR offset 0x00 — status register (bit 7 = TXE, bit 5 = RXNE, bit 6 = TC)
// DATAR offset 0x04 — data register (write = TX, read = RX)
const UART1_BASE  = 0x40013800;
const UART1_SIZE  = 0x400;
const UART1_STATR = 0x00;
const UART1_DATAR = 0x04;

// ── CH32V003 GPIO MMIO ───────────────────────────────────────────────────────
// Each GPIO bank: CRL=0x00, CRH=0x04, INDR=0x08, OUTDR=0x0C, BSHR=0x10, BCR=0x14, LCKR=0x18
const GPIOA_BASE = 0x40010800;
const GPIOC_BASE = 0x40010C00;
const GPIOD_BASE = 0x40011400;
const GPIO_SIZE  = 0x400;
const GPIO_OUTDR = 0x0c;  // Output data register

// Pin offsets: PA0-7 → simulator pins 0-7, PC0-7 → 8-15, PD0-7 → 16-23
const GPIO_PIN_OFFSET: Record<number, number> = {
  [GPIOA_BASE]: 0,
  [GPIOC_BASE]: 8,
  [GPIOD_BASE]: 16,
};

export class RiscVSimulator {
  private core: RiscVCore;
  private running = false;
  private animFrameId = 0;
  private rxFifo: number[] = [];
  private gpioOutdr: Record<number, number> = {
    [GPIOA_BASE]: 0,
    [GPIOC_BASE]: 0,
    [GPIOD_BASE]: 0,
  };

  public pinManager: PinManager;
  public onSerialData: ((ch: string) => void) | null = null;
  public onBaudRateChange: ((baud: number) => void) | null = null;
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;

  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;

    // Flat memory: flash at offset 0, RAM at offset FLASH_SIZE
    const mem = new Uint8Array(MEM_SIZE);
    this.core = new RiscVCore(mem, FLASH_BASE);

    this._registerUart();
    this._registerGpio(GPIOA_BASE);
    this._registerGpio(GPIOC_BASE);
    this._registerGpio(GPIOD_BASE);

    // Map RAM: RiscVCore only covers [FLASH_BASE, FLASH_BASE + MEM_SIZE).
    // To make RAM work we extend by adding a second MMIO region that redirects
    // to the same flat buffer at offset FLASH_SIZE.
    const ramOffset = FLASH_SIZE;
    this.core.addMmio(RAM_BASE, RAM_SIZE,
      (addr) => mem[ramOffset + (addr - RAM_BASE)],
      (addr, val) => { mem[ramOffset + (addr - RAM_BASE)] = val; },
    );
  }

  // ── MMIO registration ──────────────────────────────────────────────────────

  private _registerUart(): void {
    this.core.addMmio(UART1_BASE, UART1_SIZE,
      (addr) => {
        const off = addr - UART1_BASE;
        if (off === UART1_STATR) {
          // TXE (bit 7) always ready; RXNE (bit 5) set when RX FIFO has data
          return 0b1000_0000 | (this.rxFifo.length > 0 ? 0b0010_0000 : 0);
        }
        if (off === UART1_DATAR) {
          return this.rxFifo.length > 0 ? this.rxFifo.shift()! : 0;
        }
        return 0;
      },
      (addr, val) => {
        const off = addr - UART1_BASE;
        if (off === UART1_DATAR) {
          this.onSerialData?.(String.fromCharCode(val & 0xff));
        }
      },
    );
  }

  private _registerGpio(base: number): void {
    const pinOffset = GPIO_PIN_OFFSET[base];
    this.core.addMmio(base, GPIO_SIZE,
      (addr) => {
        const off = addr - base;
        if (off === GPIO_OUTDR) return this.gpioOutdr[base];
        return 0;
      },
      (addr, val) => {
        const off = addr - base;
        if (off === GPIO_OUTDR) {
          const prev = this.gpioOutdr[base];
          this.gpioOutdr[base] = val;
          const changed = prev ^ val;
          if (changed) {
            const timeMs = (this.core.cycles / CPU_HZ) * 1000;
            for (let bit = 0; bit < 8; bit++) {
              if (changed & (1 << bit)) {
                const pin = pinOffset + bit;
                const state = !!(val & (1 << bit));
                this.onPinChangeWithTime?.(pin, state, timeMs);
                this.pinManager.setPinState(pin, state);
              }
            }
          }
        }
      },
    );
  }

  // ── HEX loading ────────────────────────────────────────────────────────────

  loadHex(hexContent: string): void {
    // Reset flash region
    const mem = (this.core as unknown as { mem: Uint8Array }).mem;
    mem.fill(0, 0, FLASH_SIZE);

    const bytes = hexToUint8Array(hexContent);
    const maxCopy = Math.min(bytes.length, FLASH_SIZE);
    mem.set(bytes.subarray(0, maxCopy), 0);

    this.core.reset(FLASH_BASE);
    console.log(`[RiscV] Loaded ${maxCopy} bytes`);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animFrameId);
  }

  reset(): void {
    this.stop();
    this.rxFifo = [];
    this.gpioOutdr = { [GPIOA_BASE]: 0, [GPIOC_BASE]: 0, [GPIOD_BASE]: 0 };
    this.core.reset(FLASH_BASE);
  }

  serialWrite(text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.rxFifo.push(text.charCodeAt(i));
    }
  }

  setPinState(_pin: number, _state: boolean): void {
    // Input pin injection not yet implemented for RISC-V GPIO
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Execution loop ─────────────────────────────────────────────────────────

  private _loop(): void {
    if (!this.running) return;
    for (let i = 0; i < CYCLES_PER_FRAME; i++) {
      this.core.step();
    }
    this.animFrameId = requestAnimationFrame(() => this._loop());
  }
}
