/**
 * serialWire — the seam where the host's serial TERMINAL meets the board's UART.
 *
 * A serial monitor is not a window into the sketch: it is a second device on a wire,
 * and it only reads what the board sent if both ends agree on the line settings. Set
 * the terminal to 9600 while the sketch talks at 115200 and a real monitor prints
 * garbage — that is the single most common first-day mistake in embedded teaching, and
 * a simulator that silently "fixes" it teaches the wrong lesson.
 *
 * So the board publishes the line it is actually clocking (`setBoardSerialLink`, fed by
 * the AVR USART's UBRR and by the ESP32 engines' decoded CLKDIV/CLK_CONF), and a model
 * installed here gets to decide what the terminal at the other end makes of those bytes.
 * Nothing in OSS installs one, so the default is the identity: bytes through unchanged.
 * The pro overlay installs a bit-level 8N1 receiver (sample at mid-bit on the RECEIVER's
 * clock, resync on the next start edge) which reproduces the real garbage, in both
 * directions — typing into a mismatched terminal corrupts what the board receives too.
 *
 * Applied per flush of the serial batcher, i.e. per burst of bytes: a burst is clocked
 * back to back, and the line idles between bursts, which is how a `Serial.println` in a
 * loop reaches the pins. Bytes from a REAL board (Web Serial hardware monitor) have
 * already crossed a real wire at a rate the user picked, so the model leaves them alone.
 */

/** A UART's live line settings, as the board is clocking them right now. */
export interface SerialLink {
  /**
   * Where `Serial` is physically going. 'usb-cdc' is a USB device endpoint (ESP32-S3/C3
   * CDC_ON_BOOT builds, RP2040 USB serial): there is no wire and no baud, and the
   * terminal's setting is discarded by the host driver exactly as on real hardware.
   */
  source: 'uart' | 'usb-cdc';
  /** Bits per second the board is clocking at — the ACHIEVED rate, divider error and
   *  all (an ESP32 asked for 115200 off the 80 MHz APB really sends 115201). 0 = not
   *  configured yet. */
  baud: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: number;
}

/**
 * The two halves of a host terminal. Kept byte-oriented on the way IN because what the
 * board receives are bytes — running a corrupted frame back through a UTF-8 encoder
 * would invent a second, imaginary corruption on top of the modelled one.
 */
export interface SerialWireModel {
  /** What the terminal DISPLAYS for a burst the board just clocked out. */
  display(boardId: string, text: string): string;
  /** What the board's UART RECEIVES when the terminal transmits these bytes. */
  transmit(boardId: string, bytes: Uint8Array): Uint8Array;
}

/** The rates a serial monitor offers; also the set a decoded rate is named by. */
export const STANDARD_BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000,
  921600, 1000000, 2000000,
];

/**
 * How far a clocked rate may sit from a standard one and still be called by it.
 *
 * A UART divides its clock by an integer, so the rate a sketch asks for is rarely
 * the rate it gets. An Uno asked for 115200 runs U2X with UBRR 16, 117647 baud
 * (+2.1 %, Microchip AVR306 Table 3-5), and the Uno's own USB bridge runs the same
 * divider; 57600 gives 58823 (+2.1 %) and 230400 gives 222222 (-3.5 %). Every one of
 * those links works: an 8N1 frame tolerates about 3.3 % of total clock mismatch on a
 * normal link (Maxim AN2141). Adjacent standard rates are at least 7.8 % apart
 * (230400/250000, 460800/500000, 921600/1000000), so inside 4 % a rate is always
 * nearer the one it is called by than any other (velxio/velxio-prod#193).
 */
const NOMINAL_BAUD_TOLERANCE = 0.04;

/**
 * The nominal rate a decoded one is called by — 117647 is "115200" on the label,
 * because that is the rate the sketch asked for and the number a student has to
 * match in the monitor. Anything further off than NOMINAL_BAUD_TOLERANCE is a
 * genuinely different rate and keeps its own number; a divider that lands on
 * ANOTHER standard rate (460800 on a 16 MHz AVR clocks 500000) is called by that one,
 * because that is the rate on the wire.
 */
export function nominalBaud(baud: number): number {
  if (!(baud > 0)) return 0;
  let best = baud;
  let bestErr = NOMINAL_BAUD_TOLERANCE;
  for (const std of STANDARD_BAUD_RATES) {
    const err = Math.abs(std - baud) / std;
    if (err < bestErr) {
      best = std;
      bestErr = err;
    }
  }
  return best;
}

/**
 * The tooltip of the monitor's baud label. The label shows the nominal rate; when
 * that rounds a divider error away, the tooltip keeps the rate the board really
 * clocks and how far off it is (117647 is +2.1 % from 115200 on an Uno), which is
 * the number a scope or a logic analyser on the TX pin measures.
 */
export function baudLabelTitle(baud: number): string {
  const base = 'The rate the board is clocking Serial at.';
  const nominal = nominalBaud(baud);
  if (!(baud > 0) || nominal === baud) return base;
  const off = ((baud - nominal) / nominal) * 100;
  if (Math.abs(off) < 0.05) return base;
  const sign = off > 0 ? '+' : '-';
  return (
    `${base} Its divider gives ${baud.toLocaleString()} baud, ` +
    `${sign}${Math.abs(off).toFixed(1)} % from ${nominal.toLocaleString()}: ` +
    'inside what an 8N1 receiver tolerates, so a monitor at ' +
    `${nominal.toLocaleString()} reads it.`
  );
}

let model: SerialWireModel | null = null;
let warned = false;

/** Install (or clear with null) the single host-terminal model. */
export function installSerialWireModel(fn: SerialWireModel | null): void {
  model = fn;
}

/** A model that throws must never cost the monitor a frame of output or swallow the
 *  user's keystrokes, so the error stops here and the raw bytes go through — a broken
 *  model degrades to today's behaviour, it does not lose your log. */
function guard<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[serialWire] model threw; raw bytes will be used from here on:', err);
    }
    return fallback;
  }
}

/** What the monitor shows for bytes the board clocked out. Identity with no model. */
export function applySerialWireDisplay(boardId: string, text: string): string {
  if (!model || !text) return text;
  return guard(() => model!.display(boardId, text), text);
}

/** What the board receives for bytes the monitor sent. Identity with no model. */
export function applySerialWireTransmit(boardId: string, bytes: Uint8Array): Uint8Array {
  if (!model || bytes.length === 0) return bytes;
  return guard(() => model!.transmit(boardId, bytes), bytes);
}
