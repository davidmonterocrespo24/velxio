/**
 * Cross-board audit: a wire drawn on a board's protocol pins must classify as
 * UART/I2C/SPI (not raw digital) so the Interconnect installs the byte-level
 * bridge. Tests every supported board against the pin labels its element
 * actually exposes.
 *
 * Boards expose pins differently:
 *   - Arduino Uno/Nano: numbers + TX/RX/SDA/SCL labels.
 *   - Arduino Mega: numbers for UART, dedicated SDA/SCL labels for I2C.
 *   - ESP32 / ESP32-C3: TX0/RX0/TX2/RX2 labels + GPIO numbers.
 *   - Pico/Pico-W: GPn labels.
 *   - STM32 Blue Pill: PAn/PBn port labels.
 *   - Raspberry Pi 3/4/5: PHYSICAL pin numbers (1..40) -> BCM.
 */
import { describe, it, expect } from 'vitest';
import { classifyPin } from '../utils/boardProtocols';

const notDigital = (bk: string, pin: string) => {
  const r = classifyPin(bk, pin);
  expect(r.kind, `${bk} pin ${pin} classified as ${r.kind}`).not.toBe('digital');
  return r;
};

describe('board protocol-pin classification (multi-board interconnect)', () => {
  it('Arduino Uno/Nano: TX/RX/SDA/SCL', () => {
    for (const bk of ['arduino-uno', 'arduino-nano']) {
      expect(classifyPin(bk, 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
      expect(classifyPin(bk, 'RX')).toEqual({ kind: 'uart-rx', uart: 0 });
      expect(classifyPin(bk, 'SDA')).toEqual({ kind: 'i2c-sda', bus: 0 });
      expect(classifyPin(bk, 'SCL')).toEqual({ kind: 'i2c-scl', bus: 0 });
    }
  });

  it('Arduino Mega: 4 UARTs by label + dedicated SDA/SCL', () => {
    expect(classifyPin('arduino-mega', 'TX1')).toEqual({ kind: 'uart-tx', uart: 1 });
    expect(classifyPin('arduino-mega', 'RX1')).toEqual({ kind: 'uart-rx', uart: 1 });
    expect(classifyPin('arduino-mega', 'TX2')).toEqual({ kind: 'uart-tx', uart: 2 });
    expect(classifyPin('arduino-mega', 'TX3')).toEqual({ kind: 'uart-tx', uart: 3 });
    expect(classifyPin('arduino-mega', 'SDA')).toEqual({ kind: 'i2c-sda', bus: 0 });
    expect(classifyPin('arduino-mega', 'SCL')).toEqual({ kind: 'i2c-scl', bus: 0 });
  });

  it('ESP32 variants + C3: UART labels', () => {
    for (const bk of ['esp32', 'esp32-devkit-c-v4', 'esp32-cam', 'esp32-s3']) {
      notDigital(bk, 'TX0');
      notDigital(bk, 'RX0');
    }
    // TX2/RX2 answer per variant now that each board reads its own pin
    // function table: UART2 on the classic chip, UART1 on the S3 (same pads,
    // different silicon), and nothing on the CAM, which breaks neither out.
    for (const bk of ['esp32', 'esp32-devkit-c-v4']) {
      notDigital(bk, 'TX2');
      notDigital(bk, 'RX2');
    }
    expect(classifyPin('esp32-s3', 'TX2')).toEqual({ kind: 'uart-tx', uart: 1 });
    expect(classifyPin('esp32-cam', 'TX2')).toEqual({ kind: 'digital' });
    expect(classifyPin('esp32-c3', 'TX')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('esp32-c3', 'SDA')).toEqual({ kind: 'i2c-sda', bus: 0 });
  });

  it('Pico/Pico-W: GPn labels', () => {
    for (const bk of ['raspberry-pi-pico', 'pi-pico-w']) {
      notDigital(bk, 'GP0');
      notDigital(bk, 'GP1');
    }
  });

  it('STM32 Blue Pill: PAn USART labels', () => {
    expect(classifyPin('stm32-bluepill', 'PA9')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('stm32-bluepill', 'PA10')).toEqual({ kind: 'uart-rx', uart: 0 });
  });

  it('Raspberry Pi 3: physical pin numbers map to BCM protocol roles', () => {
    // Physical 8/10 = BCM14/15 = UART0; physical 3/5 = BCM2/3 = I2C1.
    expect(classifyPin('raspberry-pi-3', '8')).toEqual({ kind: 'uart-tx', uart: 0 });
    expect(classifyPin('raspberry-pi-3', '10')).toEqual({ kind: 'uart-rx', uart: 0 });
    expect(classifyPin('raspberry-pi-3', '3')).toEqual({ kind: 'i2c-sda', bus: 1 });
    expect(classifyPin('raspberry-pi-3', '5')).toEqual({ kind: 'i2c-scl', bus: 1 });
  });
});
