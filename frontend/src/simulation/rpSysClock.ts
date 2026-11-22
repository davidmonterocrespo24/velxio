/**
 * The system clock an RP2040 guest programmed, as its own code computes rates
 * from it.
 *
 * rp2040js runs the core and every peripheral on a fixed `clkSys` of 125 MHz
 * and has no PLL model (PLL_SYS is an unimplemented peripheral: writes are
 * dropped, reads say "locked"). The guest does set one up: pico-sdk's
 * clocks_init runs the PLL at the SDK's default system clock, 200 MHz on the
 * RP2040 since pico-sdk 2.1.1, which arduino-pico builds with, and
 * set_sys_clock_khz() moves it. A rate the guest derives from clk_sys is then
 * counted for that clock: Wire.begin() at 100 kHz writes SCL counts of
 * 1200 + 800 clk_sys cycles, 10 us at 200 MHz and 16 us at the engine's
 * 125 MHz. The oscilloscope draws the bus at the rate the guest asked for,
 * which is what the board does (velxio/velxio-prod#160).
 *
 * clk_sys (RP2040 datasheet 2.15.7, CLK_SYS_CTRL): SRC 0 = clk_ref, 1 = the
 * aux mux, whose AUXSRC [7:5] is 0 = pll_sys, 1 = pll_usb (48 MHz), 2 = rosc,
 * 3 = xosc (12 MHz); CLK_SYS_DIV is INT [31:8] + FRAC [7:0] / 256. pll_sys
 * (2.18.2) = 12 MHz / REFDIV * FBDIV / (POSTDIV1 * POSTDIV2), from CS [5:0],
 * FBDIV_INT [11:0] and PRIM [18:16] / [14:12].
 */

/** rp2040js keys its peripheral map by address >> 12; PLL_SYS is at 0x40028000. */
export const RP2040_PLL_SYS_KEY = 0x40028;

const CLK_SYS_CTRL = 0x3c;
const CLK_SYS_DIV = 0x40;
const PLL_CS = 0x0;
const PLL_FBDIV_INT = 0x8;
const PLL_PRIM = 0xc;
const XOSC_HZ = 12_000_000;
const PLL_USB_HZ = 48_000_000;
const ROSC_HZ = 6_500_000;

interface Peripheral {
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
}

/** The slice of rp2040js `RP2040` this needs. */
export interface RpSysClockMcu {
  clkSys: number;
  peripherals: Record<number, Peripheral | undefined>;
}

/**
 * Follow the guest's clk_sys from the PLL_SYS writes it makes and the CLOCKS
 * block's CLK_SYS registers. Returns a reader of the guest's clk_sys in Hz;
 * until the guest sets up a PLL it is the engine's own clkSys.
 */
export function trackRpSysClock(
  mcu: RpSysClockMcu,
  clocksKey: number,
  pllSysKey: number = RP2040_PLL_SYS_KEY,
): () => number {
  let refdiv = 1;
  let fbdiv = 0;
  let post1 = 1;
  let post2 = 1;
  const pll = mcu.peripherals[pllSysKey];
  if (pll) {
    const write = pll.writeUint32.bind(pll);
    pll.writeUint32 = (offset: number, value: number): void => {
      write(offset, value);
      if (offset === PLL_CS) refdiv = value & 0x3f || 1;
      else if (offset === PLL_FBDIV_INT) fbdiv = value & 0xfff;
      else if (offset === PLL_PRIM) {
        post1 = (value >>> 16) & 0x7 || 1;
        post2 = (value >>> 12) & 0x7 || 1;
      }
    };
  }
  const clocks = mcu.peripherals[clocksKey];
  return (): number => {
    if (!clocks) return mcu.clkSys;
    const ctrl = clocks.readUint32(CLK_SYS_CTRL);
    let hz: number;
    if ((ctrl & 1) === 0) {
      // clk_ref: the guest runs on it only before clocks_init.
      return mcu.clkSys;
    }
    switch ((ctrl >>> 5) & 0x7) {
      case 0:
        if (fbdiv === 0) return mcu.clkSys;
        hz = ((XOSC_HZ / refdiv) * fbdiv) / (post1 * post2);
        break;
      case 1:
        hz = PLL_USB_HZ;
        break;
      case 2:
        hz = ROSC_HZ;
        break;
      case 3:
        hz = XOSC_HZ;
        break;
      default:
        return mcu.clkSys;
    }
    const div = clocks.readUint32(CLK_SYS_DIV) >>> 0;
    const divisor = (div >>> 8) + (div & 0xff) / 256;
    return divisor >= 1 ? hz / divisor : hz;
  };
}
