/**
 * boardPinToNumber — the bridge between a board element's PAD NAMES and the
 * GPIO numbers the simulators speak.
 *
 * A board whose kind has no branch here falls through to `return null`, and a
 * null pin means every wire to that header silently connects to nothing: the
 * part sits on the canvas, the sketch reads a dead pin, and nothing reports an
 * error. That is what happened to the M5 Cardputer, whose EXT header and Grove
 * Port A were unreachable even though the element drew them.
 */
import { describe, expect, it } from 'vitest';
import { boardPinToNumber } from '../utils/boardPinMapping';

describe('boardPinToNumber — M5 Cardputer ADV header', () => {
  // The pad names CardputerElement.ts renders on its wireable bottom row.
  const GPIO_NAMES = ['3', '4', '5', '6', '8', '9', '13', '14', '15', '39', '40', '2', '1'];

  it('maps every GPIO pad to its own number', () => {
    for (const name of GPIO_NAMES) {
      expect(boardPinToNumber('cardputer-adv', name)).toBe(Number(name));
    }
  });

  it('leaves no pad unmapped', () => {
    const unmapped = GPIO_NAMES.filter((n) => boardPinToNumber('cardputer-adv', n) === null);
    expect(unmapped).toEqual([]);
  });

  it('maps the power pads to -1, not to a GPIO', () => {
    expect(boardPinToNumber('cardputer-adv', '5V')).toBe(-1);
    expect(boardPinToNumber('cardputer-adv', 'GND')).toBe(-1);
  });

  it('accepts G40, which the classic ESP32 range would have rejected', () => {
    // The shared esp32 branch clamps at 39; the S3 has 48 GPIOs and this board
    // exposes 40 on its header.
    expect(boardPinToNumber('cardputer-adv', '40')).toBe(40);
  });

  it('rejects a pad that is not a pin', () => {
    expect(boardPinToNumber('cardputer-adv', 'NOPE')).toBeNull();
    expect(boardPinToNumber('cardputer-adv', '99')).toBeNull();
  });
});

describe('m5stack-core header pins', () => {
  // The Core's pads sat unmapped for months: the kind does not start with
  // 'esp32', so it fell through every branch and each wire from the M-Bus
  // header resolved to null — a part wired to the header never saw a signal,
  // silently. These pin the dedicated branch.
  const CORE_GPIO = ['21', '22', '23', '19', '18', '3', '1', '16', '17', '2', '5', '25', '26', '35', '36', '12', '13', '15', '0', '34'];

  it('maps every M-Bus GPIO pad to its number', () => {
    for (const name of CORE_GPIO) {
      expect(boardPinToNumber('m5stack-core', name)).toBe(Number(name));
    }
  });

  it('maps the power pads (including BAT) to -1', () => {
    for (const name of ['5V', 'GND', '3V3', 'BAT']) {
      expect(boardPinToNumber('m5stack-core', name)).toBe(-1);
    }
  });

  it('rejects out-of-range and non-pins', () => {
    expect(boardPinToNumber('m5stack-core', '40')).toBeNull(); // classic tops out at 39
    expect(boardPinToNumber('m5stack-core', 'NOPE')).toBeNull();
  });
});

/**
 * ESP32-family pads — no pad may resolve to null, and no supply pad may
 * resolve to a GPIO.
 *
 * Two shapes of this bug shipped at once. `parseInt('3V', 10)` is 3, so the
 * Wemos Lolin32 Lite's supply pad resolved to GPIO3 and the XIAO's 3V3/5V pads
 * to GPIO3/GPIO5 — a wire to the rail drove a real pin. And a pad the mapper
 * cannot name returns null, which means the wire connects to nothing at all:
 * the DevKit V1's RX0/TX0 (the only route to GPIO1 and GPIO3, with no numeric
 * twin), the Nano ESP32's RX0/TX1 (its map named them D0/D1, pads that do not
 * exist on the element), and the S3 DevKitC's 40..48, rejected by a GPIO
 * ceiling of 39 shared with the classic ESP32.
 *
 * Expected values cross-checked against the `target` field of the upstream
 * wokwi-boards board.json for each board.
 *
 * The pad lists are copied verbatim from Esp32Element.ts (BOARD_CONFIGS) —
 * same convention as pin-inspector-layout.test.ts, because vitest runs in the
 * `node` environment and that module calls customElements.define at import.
 * If a board's pads change, refresh the copy.
 */
const ESP32_FAMILY_PADS: Record<string, string[]> = {
  'esp32': [
    'EN', 'VP', 'VN', '34', '35', '32', '33', '25', '26', '27', '14', '12', '13', 'GND',
    'VIN', '3V3', 'GND2', '15', '2', '4', 'RX2', '16', 'TX2', '17', '5', '18', '19',
    '21', 'RX0', 'TX0', '22', '23',
  ],
  'esp32-s3': [
    '3V3.1', '3V3.2', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46',
    '9', '10', '11', '12', '13', '14', '5V', 'GND.1', 'GND.2', 'TX', 'RX', '1', '2',
    '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20',
    '19', 'GND.3', 'GND.4',
  ],
  'esp32-c3': [
    'GND.1', '3V3.1', '3V3.2', '2', '3', 'GND.2', 'RST', 'GND.3', '0', '1', '10', 'GND.4',
    '5V.1', '5V.2', 'GND.5', 'GND.6', '19', '18', 'GND.7', '4', '5', '6', '7', 'GND.8',
    '8', '9', 'GND.9', 'RX', 'TX', 'GND.10',
  ],
  'esp32-devkit-c-v4': [
    '3V3', 'EN', 'VP', 'VN', '34', '35', '32', '33', '25', '26', '27', '14', '12', 'GND.1',
    '13', 'D2', 'D3', 'CMD', '5V', 'GND.2', '23', '22', 'TX', 'RX', '21', 'GND.3', '19',
    '18', '5', '17', '16', '4', '0', '2', '15', 'D1', 'D0', 'CLK',
  ],
  'esp32-cam': [
    '5V.1', 'GND.1', '12', '13', '15', '14', '2', '4', '3V3', '16', '0', 'GND.2', 'VCC',
    'RX', 'TX', 'GND.3',
  ],
  'wemos-lolin32-lite': [
    'VP', 'VN', 'EN', 'GPIO34', 'GPIO35', 'GPIO32', 'GPIO33', 'GPIO25', 'GPIO26', 'GPIO27',
    'GPIO14', 'GPIO12', 'GND', 'GPIO13', 'GPIO15', 'GPIO2', 'GPIO0', 'GPIO4', 'GPIO16',
    'GPIO17', 'GPIO5', 'GPIO18', 'GPIO23', 'GPIO19', 'GPIO22', '3V',
  ],
  'xiao-esp32-s3': ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', '3V3', 'GND', '5V'],
  'arduino-nano-esp32': [
    'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND.1', 'RST',
    'RX0', 'TX1', 'D13', '3V3', 'B0', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
    'VBUS', 'B1', 'GND.2', 'VIN',
  ],
  'xiao-esp32-c3': ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', '3V3', 'GND', '5V'],
  'aitewinrobot-esp32c3-supermini': ['5', '6', '7', '8', '9', '10', 'RX', 'TX', '5V', 'GND', '3V3', '4', '3', '2', '1', '0'],
};

/**
 * The DevKitC V4 breaks out the SPI-flash block (GPIO6-11). Those pads are
 * unresolved today and stay that way here deliberately: they are not usable
 * as GPIOs, and mapping them would invite wiring to the flash bus. Listed
 * rather than skipped so the gap is visible.
 */
const UNRESOLVED_BY_DESIGN: Record<string, string[]> = {
  'esp32-devkit-c-v4': ['D0', 'D1', 'D3', 'CMD', 'CLK'],
};

const SUPPLY_PAD = /^(GND|VSS|3V|3V3|5V|VCC|VDD|VIN|VBUS|VBAT|BAT|EN|RST)([._]?\d+)?$/i;

describe('boardPinToNumber — ESP32 family pads', () => {
  for (const [kind, names] of Object.entries(ESP32_FAMILY_PADS)) {
    const allowed = UNRESOLVED_BY_DESIGN[kind] ?? [];

    it(`${kind}: every pad resolves`, () => {
      const unresolved = names
        .filter((n) => !allowed.includes(n))
        .filter((n) => boardPinToNumber(kind, n) === null);
      expect(unresolved).toEqual([]);
    });

    it(`${kind}: no supply pad resolves to a GPIO`, () => {
      const driving = names
        .filter((n) => SUPPLY_PAD.test(n))
        .filter((n) => (boardPinToNumber(kind, n) ?? -1) >= 0);
      expect(driving).toEqual([]);
    });
  }
});

describe('boardPinToNumber — the pads that were dead', () => {
  it('DevKit V1 UART pads reach GPIO1 and GPIO3', () => {
    // RX2/TX2 have numeric twins at the same coordinate ('16'/'17', added by
    // be24243e); RX0/TX0 have none, so they were the only route to 3 and 1.
    expect(boardPinToNumber('esp32', 'RX0')).toBe(3);
    expect(boardPinToNumber('esp32', 'TX0')).toBe(1);
    expect(boardPinToNumber('esp32', 'RX2')).toBe(16);
    expect(boardPinToNumber('esp32', 'TX2')).toBe(17);
  });

  it('the S3 reaches its GPIOs above 39, the classic ESP32 does not', () => {
    for (const n of ['40', '41', '42', '45', '46', '47', '48'])
      expect(boardPinToNumber('esp32-s3', n)).toBe(Number(n));
    expect(boardPinToNumber('esp32', '40')).toBeNull();
  });

  it('the Nano ESP32 reaches GPIO44/43 through the pads it actually draws', () => {
    expect(boardPinToNumber('arduino-nano-esp32', 'RX0')).toBe(44);
    expect(boardPinToNumber('arduino-nano-esp32', 'TX1')).toBe(43);
  });

  it('supply pads are -1, not the digit their name starts with', () => {
    expect(boardPinToNumber('wemos-lolin32-lite', '3V')).toBe(-1);
    expect(boardPinToNumber('xiao-esp32-s3', '3V3')).toBe(-1);
    expect(boardPinToNumber('xiao-esp32-s3', '5V')).toBe(-1);
    expect(boardPinToNumber('xiao-esp32-c3', '3V3')).toBe(-1);
    expect(boardPinToNumber('aitewinrobot-esp32c3-supermini', '5V')).toBe(-1);
    expect(boardPinToNumber('arduino-nano-esp32', '3V3')).toBe(-1);
  });

  it('reset pads are -1, not null', () => {
    for (const kind of ['esp32-s3', 'esp32-c3', 'arduino-nano-esp32'])
      expect(boardPinToNumber(kind, 'RST')).toBe(-1);
  });
});
