/**
 * Phase 3 end-to-end: ESP32 rectifier via QEMU waveform injection.
 *
 * This test drives the full frontend → WebSocket → backend → QEMU pipeline:
 *
 *   1. Compile `adcReadSketch()` against esp32 DevKit.
 *   2. Load the rectifier circuit (signal-generator → diode → R → A0).
 *   3. Run the sketch, collect N `analogRead` samples over ~200 ms of
 *      wall-clock time.
 *   4. Assert the guest sees a rectified pattern (peaks near 4095 × 3/3.3,
 *      valleys near 0).
 *
 * Because QEMU binaries, the backend, and a running ESP32 toolchain are NOT
 * part of the default CI image, this test is **gated** behind the env var
 *   VELXIO_ESP32_E2E=1
 * Run locally with:
 *   VELXIO_ESP32_E2E=1 npm test -- esp32-rectifier-integration
 */
import { describe, it } from 'vitest';

const GATE = process.env.VELXIO_ESP32_E2E === '1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybe: any = GATE ? describe : describe.skip;

maybe('ESP32 rectifier — QEMU waveform injection E2E', () => {
  it(
    'analogRead on ESP32 returns a rectified pattern matching the SPICE waveform',
    { timeout: 180_000 },
    async () => {
      // The full test body lives behind this gate so it is never imported
      // when the env var is not set — avoids pulling in the full QEMU/WS
      // stack on every CI run.
      const { rectifierAdcTest } = await import('./helpers/esp32RectifierE2E');
      await rectifierAdcTest();
    },
  );
});
