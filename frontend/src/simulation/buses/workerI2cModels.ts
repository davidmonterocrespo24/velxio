/**
 * The I2C chips a QEMU worker can host (project board-buses-2026-09, F5).
 *
 * An ESP32 or an STM32 on QEMU answers every I2C event from models that live
 * beside the guest, because the guest asks for each ACK and each byte
 * synchronously and the tab is a network hop away. A part reaches those
 * models by sending its record (`registerSensor`), and a record of a type the
 * worker has no branch for is dropped without a word. So "is this chip there
 * for the guest" is a question about the type, answered by the worker's own
 * registration branches: `app/services/esp32_worker.py` (`_init_sensors` and
 * `sensor_attach`) and `pro/backend/app/pro_boards/stm32_worker.py`, which
 * take the same set. A test reads the ESP32 worker to hold this list to it.
 *
 * The write sinks are here too: a display or an expander has no answer to
 * give, but on QEMU nothing ACKs its address unless the worker holds a sink
 * for it, and the bytes reach the tab only through that sink's echo.
 *
 * Leaf module: no imports.
 */
export const WORKER_I2C_MODELS: ReadonlySet<string> = new Set([
  'mpu6050',
  'bmp280',
  'ds1307',
  'ds3231',
  'ssd1306',
  'pcf8574',
  'i2c-write-sink',
  'custom-chip',
]);
