/**
 * Regression: ESP32 UART pin names must classify as UART so the multi-board
 * Interconnect bridges Serial between two ESP32s.
 *
 * Bug: a user wired two esp32-devkit-c-v4 boards TX2->RX2 (Serial2) and got no
 * data on the receiver. classifyPin() returned 'digital' because:
 *   - the TX/RX aliases only matched boardKind === 'esp32' exactly (not the
 *     'esp32-devkit-c-v4' / 'esp32-cam' / 'esp32-s3' variants), and
 *   - TX2/RX2 were not handled at all.
 * So the wires were treated as raw digital and the byte-level UART shortcut was
 * never installed.
 */
import { describe, it, expect } from 'vitest';
import { classifyPin, isUartWire } from '../utils/boardProtocols';

describe('ESP32 UART pin classification (multi-board Serial)', () => {
  // The classifier now reads the board's pin function table (project
  // board-buses-2026-09), so each variant answers for ITS silicon instead of
  // the classic ESP32's table. GPIO17/16 are UART2 on the classic chip and
  // UART1 on the S3, and an ESP32-CAM does not break them out at all.
  for (const bk of ['esp32', 'esp32-devkit-c-v4']) {
    it(`${bk}: TX/RX -> UART0, TX2/RX2 -> UART2`, () => {
      expect(classifyPin(bk, 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
      expect(classifyPin(bk, 'RX')).toEqual({ kind: 'uart-rx', uart: 0 });
      expect(classifyPin(bk, 'TX2')).toEqual({ kind: 'uart-tx', uart: 2 });
      expect(classifyPin(bk, 'RX2')).toEqual({ kind: 'uart-rx', uart: 2 });
      // GPIO-numbered pins keep working too.
      expect(classifyPin(bk, 'GPIO17')).toEqual({ kind: 'uart-tx', uart: 2 });
      expect(classifyPin(bk, '16')).toEqual({ kind: 'uart-rx', uart: 2 });
    });
  }

  it('esp32-cam: TX/RX -> UART0; it breaks out no UART2 pin', () => {
    expect(classifyPin('esp32-cam', 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('esp32-cam', 'RX')).toEqual({ kind: 'uart-rx', uart: 0 });
    // GPIO16 is the PSRAM line on this module and GPIO17 is not on the header.
    expect(classifyPin('esp32-cam', 'TX2')).toEqual({ kind: 'digital' });
  });

  it('esp32-s3: TX/RX -> UART0 on 43/44, and 17/16 are UART1, not UART2', () => {
    expect(classifyPin('esp32-s3', 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('esp32-s3', 'RX')).toEqual({ kind: 'uart-rx', uart: 0 });
    expect(classifyPin('esp32-s3', 'GPIO43')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('esp32-s3', 'GPIO44')).toEqual({ kind: 'uart-rx', uart: 0 });
    expect(classifyPin('esp32-s3', 'GPIO17')).toEqual({ kind: 'uart-tx', uart: 1 });
    expect(classifyPin('esp32-s3', '18')).toEqual({ kind: 'uart-rx', uart: 1 });
  });

  it('esp32-c3 uses its own UART0 pins (21/20)', () => {
    expect(classifyPin('esp32-c3', 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('esp32-c3', 'RX')).toEqual({ kind: 'uart-rx', uart: 0 });
    // c3 has no UART2 — TX2 is not a UART pin.
    expect(classifyPin('esp32-c3', 'TX2').kind).not.toBe('uart-tx');
  });

  it('a TX2 -> RX2 wire between two ESP32s is a UART link', () => {
    expect(isUartWire('esp32-devkit-c-v4', 'TX2', 'esp32-devkit-c-v4', 'RX2')).toBeTruthy();
    expect(isUartWire('esp32', 'TX', 'esp32', 'RX')).toBeTruthy();
    // GPIO-labelled pins resolve to the same link.
    expect(isUartWire('esp32-devkit-c-v4', 'GPIO17', 'esp32-devkit-c-v4', 'GPIO16')).toBeTruthy();
  });
});
