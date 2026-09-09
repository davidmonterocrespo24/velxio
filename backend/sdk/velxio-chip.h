/*
 * velxio-chip.h — Public API for Velxio custom chips.
 *
 * Independent, clean-room API. No code from third-party simulators.
 * License: MIT (Velxio project).
 *
 * A chip is a WebAssembly module that imports the host functions declared
 * here and exports `chip_setup()`. The host calls `chip_setup()` once per
 * chip instance to register pins, attributes, I2C/UART/SPI peripherals,
 * and timers. After setup, the chip is purely reactive: it runs only
 * inside callbacks invoked by the host (pin watch, I2C bus, timer fire).
 */

#ifndef VELXIO_CHIP_H
#define VELXIO_CHIP_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/* ─── Pins ──────────────────────────────────────────────────────────────── */

typedef int32_t vx_pin;

typedef enum {
  VX_INPUT          = 0,
  VX_OUTPUT         = 1,
  VX_INPUT_PULLUP   = 2,
  VX_INPUT_PULLDOWN = 3,
  VX_ANALOG         = 4,
  /* Output that initializes the pin to a specific level — eliminates the brief
   * window between vx_pin_register() and the first vx_pin_write() during which
   * a plain VX_OUTPUT pin would default to LOW. */
  VX_OUTPUT_LOW     = 16,
  VX_OUTPUT_HIGH    = 17,
} vx_pin_mode;

typedef enum {
  VX_LOW  = 0,
  VX_HIGH = 1,
} vx_pin_value;

typedef enum {
  VX_EDGE_RISING  = 1,
  VX_EDGE_FALLING = 2,
  VX_EDGE_BOTH    = 3,
} vx_edge;

/** Register a logical pin on the chip. The host wires it via the diagram. */
extern vx_pin vx_pin_register(const char* name, vx_pin_mode mode);

/** Read the digital value (0 or 1) of a pin. */
extern int    vx_pin_read(vx_pin p);

/** Drive a digital value on an OUTPUT pin. */
extern void   vx_pin_write(vx_pin p, int value);

/** Read the analog voltage (0.0 .. supply_volts) of a pin. */
extern double vx_pin_read_analog(vx_pin p);

/** Drive an analog voltage (volts) on an OUTPUT/ANALOG pin (DAC). */
extern void   vx_pin_dac_write(vx_pin p, double voltage);

/**
 * Report a PWM duty cycle (0.0 .. 1.0, clamped by the host) on a pin.
 * A driver stage that chops its output has to say "half", not "high": the
 * load on the other end of the wire reads the duty, and a bare digital level
 * would make every speed look like full throttle. The pin's digital level is
 * left exactly as it was — use vx_pin_write to move that. On a pin the
 * diagram wires to nothing, this does nothing.
 */
extern void   vx_pin_pwm_write(vx_pin p, double duty);

/** Change a pin's mode after registration. Useful for bidirectional I/O. */
extern void   vx_pin_set_mode(vx_pin p, vx_pin_mode mode);

/**
 * Watch a pin for edge events. The callback is dispatched inside the
 * simulation loop when the pin state crosses the requested edge.
 */
extern void vx_pin_watch(
  vx_pin p,
  vx_edge edge,
  void (*cb)(void* user_data, vx_pin pin, int value),
  void* user_data
);

/** Stop watching a pin. Removes every callback registered for it. */
extern void vx_pin_watch_stop(vx_pin p);

/* ─── Attributes (user-editable parameters from the diagram editor) ─────── */

typedef int32_t vx_attr;

extern vx_attr vx_attr_register(const char* name, double default_val);
extern double  vx_attr_read(vx_attr a);

/* String attributes — for text parameters (a device id, an SSID, a preset
 * name). The value comes from chip.json / the diagram editor; the chip only
 * reads it. Register from chip_setup(). */
extern vx_attr  vx_attr_register_string(const char* name, const char* default_val);
/** Byte length of the current value (excluding the NUL terminator). */
extern uint32_t vx_attr_string_len(vx_attr a);
/** Copy up to `cap` bytes (including a NUL when it fits) into `buf`.
 *  Returns the number of bytes written, excluding the NUL. */
extern uint32_t vx_attr_string_read(vx_attr a, char* buf, uint32_t cap);

/* ─── I2C slave ─────────────────────────────────────────────────────────── */

typedef int32_t vx_i2c;

typedef struct {
  uint8_t  address;     /* 7-bit I2C address */
  uint8_t  _pad[3];     /* padding to 4-byte alignment of next field */
  vx_pin   scl;
  vx_pin   sda;
  bool   (*on_connect)(void* user_data, uint8_t addr, bool is_read);
  uint8_t(*on_read)(void* user_data);
  bool   (*on_write)(void* user_data, uint8_t byte);
  void   (*on_stop)(void* user_data);
  void*    user_data;
  uint32_t reserved[8];   /* forward-compat — must be zeroed by chip */
} vx_i2c_config;

_Static_assert(sizeof(vx_i2c_config) == 64, "vx_i2c_config must be 64 bytes");

/** Attach an I2C slave to the bus. Call only from chip_setup(). */
extern vx_i2c vx_i2c_attach(const vx_i2c_config* cfg);

/* ─── UART ──────────────────────────────────────────────────────────────── */

typedef int32_t vx_uart;

typedef struct {
  vx_pin   rx;
  vx_pin   tx;
  uint32_t baud_rate;
  void   (*on_rx_byte)(void* user_data, uint8_t byte);
  void   (*on_tx_done)(void* user_data);
  void*    user_data;
  uint32_t reserved[8];
} vx_uart_config;

_Static_assert(sizeof(vx_uart_config) == 56, "vx_uart_config must be 56 bytes");

extern vx_uart vx_uart_attach(const vx_uart_config* cfg);
extern bool    vx_uart_write(vx_uart u, const uint8_t* buffer, uint32_t count);

/* ─── SPI slave ─────────────────────────────────────────────────────────── */

typedef int32_t vx_spi;

/**
 * SPI configuration. The CS pin is GPIO and watched by the chip directly —
 * the runtime starts/stops transactions automatically based on its level.
 *
 * `on_done` fires after every `count` bytes received via vx_spi_start():
 *   - Before the call, `buffer` contains the chip's outgoing MISO bytes.
 *   - After the call, `buffer` contains the master's MOSI bytes received.
 */
typedef struct {
  vx_pin   sck;
  vx_pin   mosi;
  vx_pin   miso;
  vx_pin   cs;
  uint32_t mode;     /* 0..3 (SPI mode) */
  void   (*on_done)(void* user_data, uint8_t* buffer, uint32_t count);
  void*    user_data;
  uint32_t reserved[8];
} vx_spi_config;

_Static_assert(sizeof(vx_spi_config) == 60, "vx_spi_config must be 60 bytes");

extern vx_spi vx_spi_attach(const vx_spi_config* cfg);

/** Begin a transfer of `count` bytes. Buffer is bidirectional (MISO out, MOSI in). */
extern void vx_spi_start(vx_spi s, uint8_t* buffer, uint32_t count);

/** Abort an in-flight transfer. Fires `on_done` with whatever was received so far. */
extern void vx_spi_stop(vx_spi s);

/* ─── Time and timers ───────────────────────────────────────────────────── */

typedef int32_t vx_timer;

extern uint64_t vx_sim_now_nanos(void);

extern vx_timer vx_timer_create(void (*cb)(void* user_data), void* user_data);
extern void     vx_timer_start(vx_timer t, uint64_t period_nanos, bool repeat);
extern void     vx_timer_stop(vx_timer t);

/* ─── Display / framebuffer ─────────────────────────────────────────────── */

typedef int32_t vx_buffer;

/**
 * Acquire the chip's display framebuffer. Width and height are returned
 * via out-pointers — they are taken from the `display: { width, height }`
 * field of the chip's chip.json, so the chip and the diagram editor agree
 * on dimensions.
 *
 * The buffer is laid out as RGBA8888, row-major, no padding:
 *   pixel(x,y) starts at byte offset (y * width + x) * 4
 *   bytes:        R  G  B  A
 *
 * Call only from chip_setup().
 */
extern vx_buffer vx_framebuffer_init(uint32_t* out_width, uint32_t* out_height);

/** Write `data_len` bytes into the framebuffer at the given byte offset. */
extern void vx_buffer_write(vx_buffer buf, uint32_t offset, const void* data, uint32_t data_len);

/** Read `data_len` bytes from the framebuffer at the given byte offset. */
extern void vx_buffer_read(vx_buffer buf, uint32_t offset, void* data, uint32_t data_len);

/* ─── Logging ───────────────────────────────────────────────────────────── */

/** Emit a message to the host's chip log. printf() also works via WASI. */
extern void vx_log(const char* msg);

/* ─── External ROM blob ─────────────────────────────────────────────────── */

/**
 * Read a chip's external ROM blob. The blob is injected by the host before
 * `chip_setup()` runs, sourced from the `romBytes` property of the chip's
 * component (base64-encoded bytes in the diagram editor, or compiled from
 * a chip-program file like .s / .hex / .bin).
 *
 * Typical use — a CPU emulator chip loads its emulated program once at boot:
 *
 *   uint32_t rom_len = vx_rom_size();
 *   if (rom_len) vx_rom_read(0, my_rom_buf, rom_len);
 *
 * If no ROM is provided, vx_rom_size() returns 0 and vx_rom_read() is a no-op
 * — chips can fall back to a built-in default in that case.
 */
extern uint32_t vx_rom_size(void);

/** Copy `len` bytes from offset `offset` of the external ROM into `dst`.
 *  Reads past the end of the ROM are silently truncated. */
extern void vx_rom_read(uint32_t offset, uint8_t* dst, uint32_t len);

/* ─── Lifecycle (chip exports) ──────────────────────────────────────────── */

/** Required: called once per chip instance after the simulator boots. */
void chip_setup(void);

#endif /* VELXIO_CHIP_H */
