/**
 * Per-board pin classification: which pin names should be canonicalized
 * to the ground net ("0") or the Vcc rail, plus the default supply voltage.
 *
 * Extend this table as new boards are added.
 */
import type { BoardKind } from '../../types/board';

export interface BoardPinGroup {
  /** Supply voltage (V). */
  vcc: number;
  /** Pin names treated as ground. */
  gnd: string[];
  /** Pin names treated as the Vcc rail. */
  vcc_pins: string[];
}

type AllBoardKinds = BoardKind | 'default';

export const BOARD_PIN_GROUPS: Record<AllBoardKinds, BoardPinGroup> = {
  default: { vcc: 5, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['5V', 'VCC'] },

  'arduino-uno': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['5V', 'VCC', '3.3V', 'AREF'],
  },
  'arduino-nano': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND'],
    vcc_pins: ['5V', 'VCC', '3V3', 'AREF'],
  },
  'arduino-mega': {
    vcc: 5,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND.4', 'GND'],
    vcc_pins: ['5V', 'VCC', '3.3V', 'AREF'],
  },
  attiny85: { vcc: 5, gnd: ['GND'], vcc_pins: ['VCC'] },

  'raspberry-pi-pico': {
    vcc: 3.3,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['3V3', 'VBUS', 'VSYS'],
  },
  'pi-pico-w': {
    vcc: 3.3,
    gnd: ['GND.1', 'GND.2', 'GND.3', 'GND'],
    vcc_pins: ['3V3', 'VBUS', 'VSYS'],
  },
  'raspberry-pi-3': { vcc: 5, gnd: ['GND'], vcc_pins: ['5V', '3V3'] },

  esp32: { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'esp32-devkit-c-v4': { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'esp32-cam': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'wemos-lolin32-lite': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'esp32-s3': { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'xiao-esp32-s3': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'arduino-nano-esp32': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V', 'VUSB'] },
  'esp32-c3': { vcc: 3.3, gnd: ['GND', 'GND.1', 'GND.2'], vcc_pins: ['3V3', 'VIN', '5V'] },
  'xiao-esp32-c3': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
  'aitewinrobot-esp32c3-supermini': { vcc: 3.3, gnd: ['GND'], vcc_pins: ['3V3', '5V'] },
};
