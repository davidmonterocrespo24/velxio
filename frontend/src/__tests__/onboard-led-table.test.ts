/**
 * The on-board LED table (types/board.ts, issue #374).
 *
 * Every row is checked against the arduino-esp32 variant header the kind's
 * FQBN builds with (`/opt/arduino-esp32/variants/<v>/pins_arduino.h` in the
 * production image) and the vendor schematic for the polarity, which no
 * header records:
 *
 *   esp32          doitESP32devkitV1: LED_BUILTIN = 2; LED to GND, HIGH lights
 *   esp32-cam      esp32 variant (no LED_BUILTIN); AI-Thinker: flash on 4 via
 *                  a transistor (HIGH), red LED on 33 to 3V3 (LOW)
 *   lolin32-lite   LED_BUILTIN = 22; the LED's other leg on 3V3 (LOW)
 *   esp32s3        PIN_RGB_LED 48, LED_BUILTIN = SOC_GPIO_PIN_COUNT + 48
 *   XIAO_ESP32S3   LED_BUILTIN = 21; Seeed: on "when the pin is set to a low level"
 *   arduino_nano_nora  D13 = 48 = LED_BUILTIN (HIGH); LED_RED 46, LED_GREEN 0,
 *                  LED_BLUE 45 switched on by pulling LOW (Arduino docs)
 *   esp32c3        PIN_RGB_LED 8
 *   XIAO_ESP32C3   no LED symbol at all, and no LED on the board
 *   SuperMini      blue LED on 8 sunk from 3V3 (LOW); builds with esp32c3
 *
 * The AVR, Pico and ATtiny rows are the pins the canvas always watched.
 */
import { describe, it, expect } from 'vitest';
import {
  BOARD_KIND_LABELS,
  BOARD_ONBOARD_LEDS,
  onboardLedsFor,
  type BoardKind,
  type OnboardLed,
} from '../types/board';

const gpio = (pin: number, activeLow: boolean, id = 'led'): OnboardLed => ({
  id,
  kind: 'gpio',
  pin,
  activeLow,
});

const EXPECTED_ESP32: Record<string, readonly OnboardLed[]> = {
  esp32: [gpio(2, false)],
  'esp32-devkit-c-v4': [],
  'esp32-cam': [gpio(4, false, 'flash'), gpio(33, true)],
  'wemos-lolin32-lite': [gpio(22, true)],
  'esp32-s3': [{ id: 'rgb', kind: 'ws2812', pin: 48 }],
  'xiao-esp32-s3': [gpio(21, true)],
  'arduino-nano-esp32': [
    gpio(48, false),
    { id: 'rgb', kind: 'rgb-gpio', pins: { r: 46, g: 0, b: 45 }, activeLow: true },
  ],
  'esp32-c3': [{ id: 'rgb', kind: 'ws2812', pin: 8 }],
  'xiao-esp32-c3': [],
  'aitewinrobot-esp32c3-supermini': [gpio(8, true)],
};

describe('BOARD_ONBOARD_LEDS: every ESP32 kind declares its real LED, pin and polarity', () => {
  for (const [kind, leds] of Object.entries(EXPECTED_ESP32)) {
    it(`${kind}`, () => {
      expect(BOARD_ONBOARD_LEDS[kind as BoardKind]).toEqual(leds);
    });
  }

  it('no ESP32 kind is left on pin 13, the old default that lit nothing', () => {
    for (const kind of Object.keys(EXPECTED_ESP32)) {
      for (const led of onboardLedsFor(kind)) {
        if (led.kind === 'gpio' || led.kind === 'ws2812') expect(led.pin).not.toBe(13);
      }
    }
  });

  it('the three active-LOW ESP32 LEDs and the CAM red LED say so', () => {
    const activeLow = (kind: string, id = 'led') =>
      onboardLedsFor(kind).find((l) => l.id === id && l.kind === 'gpio' && l.activeLow);
    expect(activeLow('wemos-lolin32-lite')).toBeTruthy();
    expect(activeLow('xiao-esp32-s3')).toBeTruthy();
    expect(activeLow('aitewinrobot-esp32c3-supermini')).toBeTruthy();
    expect(activeLow('esp32-cam')).toBeTruthy();
  });
});

describe('BOARD_ONBOARD_LEDS: the kinds that already worked keep their pin', () => {
  it.each(['arduino-uno', 'arduino-nano', 'arduino-mega'] as const)('%s is D13, active HIGH', (kind) => {
    expect(BOARD_ONBOARD_LEDS[kind]).toEqual([gpio(13, false)]);
  });

  it.each(['raspberry-pi-pico', 'pi-pico-w'] as const)('%s is GP25', (kind) => {
    expect(BOARD_ONBOARD_LEDS[kind]).toEqual([gpio(25, false)]);
  });

  it('attiny85 is PB1', () => {
    expect(BOARD_ONBOARD_LEDS.attiny85).toEqual([gpio(1, false)]);
  });

  it('the Linux Pis and the STM32 kinds declare none here', () => {
    for (const kind of Object.keys(BOARD_KIND_LABELS) as BoardKind[]) {
      if (kind.startsWith('stm32-') || (kind.startsWith('raspberry-pi-') && kind !== 'raspberry-pi-pico')) {
        expect(BOARD_ONBOARD_LEDS[kind]).toEqual([]);
      }
    }
  });
});

describe('BOARD_ONBOARD_LEDS: shape', () => {
  it('covers every BoardKind, and nothing else', () => {
    expect(Object.keys(BOARD_ONBOARD_LEDS).sort()).toEqual(Object.keys(BOARD_KIND_LABELS).sort());
  });

  it('LED ids are unique within a kind', () => {
    for (const leds of Object.values(BOARD_ONBOARD_LEDS)) {
      const ids = leds.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('onboardLedsFor answers [] for a kind it does not know, prototype names included', () => {
    expect(onboardLedsFor('no-such-board')).toEqual([]);
    expect(onboardLedsFor('constructor')).toEqual([]);
    expect(onboardLedsFor('__proto__')).toEqual([]);
    expect(onboardLedsFor('esp32')).toBe(BOARD_ONBOARD_LEDS.esp32);
  });
});
