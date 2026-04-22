/**
 * Opt-in ESP32 rectifier E2E harness, loaded only when VELXIO_ESP32_E2E=1.
 *
 * The scaffold below sketches the contract the test must fulfil:
 *   - Spawn the FastAPI backend (or connect to an already-running one).
 *   - Compile the rectifier sketch for `esp32:esp32:esp32`.
 *   - Open the WebSocket, send `esp32_load_firmware` + `esp32_adc_waveform`.
 *   - Stream `serial_output` messages and look for rectified ADC readings.
 *
 * The full wiring is deliberately left as a TODO (marked below) because a
 * complete ESP32 toolchain + pre-built QEMU binaries are prerequisites the
 * default CI image does not carry. Plumbing is recorded here so a developer
 * with that environment can uncomment/extend and run the end-to-end path.
 */
import { expect } from 'vitest';

export async function rectifierAdcTest(): Promise<void> {
  // TODO: when running locally with a functional backend + QEMU:
  //   1. const ws = new WebSocket(`${BACKEND_WS}/ws/simulation`);
  //   2. await sendCompile(rectifierSketch(), 'esp32:esp32:esp32');
  //   3. await sendLoadFirmware(clientId, hexBytes);
  //   4. await sendAdcWaveform(clientId, 0, rectifierSamplesU12, periodNs);
  //   5. collect 50 `serial_output` frames; parse `analogRead=<n>` lines.
  //   6. assert max(n) > 3000 && min(n) < 200.
  expect(process.env.VELXIO_ESP32_E2E).toBe('1');
}
