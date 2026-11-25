/**
 * rpUartLine — the line a PL011 UART (rp2040js / rp2350js `RPUART`) is clocking,
 * published as a SerialLink so the serial monitor can be honest about a mismatch.
 *
 * Both engines expose `onBaudRateChange`, but it fires on the DIVISOR writes (IBRD /
 * FBRD) only, and pico-sdk's uart_init writes the frame format to UARTLCR_H *after*
 * the baud rate — so a link taken at that callback would carry the reset LCR_H (5 data
 * bits, no parity). The write to LCR_H (and to CR, where the port is enabled) is
 * therefore observed too, and the link is re-derived and republished on change only.
 *
 * Which port is the console is the caller's business: arduino-pico's `Serial` is the
 * USB-CDC on a real Pico, but the compile service prepends `#define Serial Serial1` to
 * an rp2040-family sketch built for the simulator, so the sketch's `Serial` IS UART0 here
 * (see RP2350Simulator.serialConsole) and the rate matters exactly as on a wire.
 */
import type { SerialLink } from '../store/serialWire';

/** The slice of rp2040js / rp2350js `RPUART` this reads; both are PL011s. */
export interface RpUartLike {
  onBaudRateChange?: (baudRate: number) => void;
  readonly baudRate: number;
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
}

/** UARTLCR_H (PL011): WLEN [6:5] = 5 + n data bits, STP2 [3], EPS [2], PEN [1]. */
const UARTLCR_H = 0x2c;
const UARTCR = 0x30;

/** A console with no wire at all: the terminal's rate is discarded, as on real hardware. */
export const USB_CDC_LINK: SerialLink = {
  source: 'usb-cdc',
  baud: 0,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
};

/** Read the line settings off a PL011, or null while it has no usable rate. */
export function rpUartLink(uart: RpUartLike): SerialLink | null {
  const baud = uart.baudRate;
  if (!Number.isFinite(baud) || !(baud > 0)) return null;
  const lcr = uart.readUint32(UARTLCR_H);
  return {
    source: 'uart',
    baud,
    dataBits: 5 + ((lcr >>> 5) & 0x3),
    parity: lcr & 0x2 ? (lcr & 0x4 ? 'even' : 'odd') : 'none',
    stopBits: lcr & 0x8 ? 2 : 1,
  };
}

/**
 * Publish `uart`'s line whenever the guest changes it. Takes over the engine's
 * `onBaudRateChange` slot and wraps `writeUint32` for the format/enable registers;
 * the engine dispatches MMIO through the instance, so the wrapper is what it calls.
 */
export function watchRpUartLine(
  uart: RpUartLike,
  onLink: (link: SerialLink) => void,
): { publish: () => void } {
  let last: SerialLink | null = null;
  const publish = (): void => {
    const link = rpUartLink(uart);
    if (!link) return;
    if (
      last &&
      last.baud === link.baud &&
      last.dataBits === link.dataBits &&
      last.parity === link.parity &&
      last.stopBits === link.stopBits
    ) {
      return;
    }
    last = link;
    onLink(link);
  };
  uart.onBaudRateChange = () => publish();
  const write = uart.writeUint32.bind(uart);
  uart.writeUint32 = (offset: number, value: number): void => {
    write(offset, value);
    if (offset === UARTLCR_H || offset === UARTCR) publish();
  };
  return { publish };
}

/** The slice of rp2040js / rp2350js `RP2040` / `RP2350` the peripheral clock needs. */
export interface RpMcuLike {
  clkSys: number;
  clkPeri: number;
  peripherals: Record<number, { writeUint32(offset: number, value: number): void } | undefined>;
}

/** CLOCKS.CLK_PERI_CTRL / _DIV offsets (same on both chips: generator 6, stride 0xc). */
const CLK_PERI_CTRL = 0x48;
const CLK_PERI_DIV = 0x4c;
/** rp2040js keys its peripheral map by address >> 14 << 2; CLOCKS_BASE differs per chip. */
export const RP2040_CLOCKS_KEY = 0x40008;
export const RP2350_CLOCKS_KEY = 0x40010;
const PLL_USB_HZ = 48_000_000;
const XOSC_HZ = 12_000_000;
const ROSC_HZ = 6_500_000;

/**
 * Keep the engine's `clkPeri` at what the guest selected in CLK_PERI_CTRL.
 *
 * Both engines hold `clkPeri` at a fixed 125 MHz and never look at the CLOCKS
 * block, but the guest does: arduino-pico's main() calls set_sys_clock_khz(), and
 * pico-sdk's set_sys_clock_pll parks clk_peri on the 48 MHz USB PLL and leaves it
 * there (PICO_CLOCK_ADJUST_PERI_CLOCK_WITH_SYS_CLOCK defaults to 0). The UART divisor
 * the sketch then programs is right for 48 MHz — Serial.begin(115200) read back as
 * 299,940 baud through a 125 MHz clkPeri, 125/48 too fast, and a monitor set to
 * 115200 would have been called a mismatch against a board that was in fact right.
 *
 * AUXSRC [7:5] (RP2040 / RP2350 datasheets, CLK_PERI_CTRL): 0 = clk_sys, 1 = pll_sys
 * (clk_sys's own PLL — the engine's clkSys is the honest stand-in), 2 = pll_usb,
 * 3 = rosc_clksrc_ph, 4 = xosc_clksrc, 5/6 = gpin (no model: left alone). The RP2350
 * adds an integer divider in CLK_PERI_DIV [31:16]; the RP2040 has none.
 */
export function watchRpPeriClock(mcu: RpMcuLike, clocksKey: number, onChange?: () => void): void {
  const clocks = mcu.peripherals[clocksKey];
  if (!clocks) return;
  let auxsrc = 0;
  let divInt = 1;
  const apply = (): void => {
    let hz: number | null;
    switch (auxsrc) {
      case 0:
      case 1:
        hz = mcu.clkSys;
        break;
      case 2:
        hz = PLL_USB_HZ;
        break;
      case 3:
        hz = ROSC_HZ;
        break;
      case 4:
        hz = XOSC_HZ;
        break;
      default:
        hz = null;
    }
    if (hz === null) return;
    const next = Math.round(hz / Math.max(1, divInt));
    if (next === mcu.clkPeri) return;
    mcu.clkPeri = next;
    onChange?.();
  };
  const write = clocks.writeUint32.bind(clocks);
  clocks.writeUint32 = (offset: number, value: number): void => {
    write(offset, value);
    if (offset === CLK_PERI_CTRL) {
      auxsrc = (value >>> 5) & 0x7;
      apply();
    } else if (offset === CLK_PERI_DIV && clocksKey === RP2350_CLOCKS_KEY) {
      divInt = (value >>> 16) & 0xffff;
      apply();
    }
  };
}
