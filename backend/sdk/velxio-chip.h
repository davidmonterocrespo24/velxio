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
 * SPI configuration.
 *
 * `cs` is the chip's select line, and the bus HONOURS it: the chip is clocked
 * only while that pin is asserted, as the silicon is. A chip with no select
 * line (a 74HC595, whose RCLK is a latch and not a select) sets it to
 * ((vx_pin)-1) and is always on the bus. The chip still watches the pin itself
 * when it wants the edges, which is the usual way to arm a transfer.
 *
 * `sck`, `mosi` and `miso` say which lines the chip is wired to: they decide
 * which bus of the board the chip sits on, so a chip whose miso leg is not
 * wired clocks bytes in and answers nothing.
 *
 * `on_done` fires after every `count` bytes received via vx_spi_start():
 *   - Before the call, `buffer` contains the chip's outgoing MISO bytes.
 *   - After the call, `buffer` contains the master's MOSI bytes received.
 *
 * `on_exchange` is optional (leave it 0, as a designated initializer does).
 * The prefilled buffer above has to be written before the chip has seen the
 * byte it answers, so a chip whose answer depends on bits of the SAME byte
 * cannot give it: the MCP3008 puts result bits in the byte that carries the
 * configuration deciding them, and through the buffer alone the most common
 * framing (spidev's [1, 0x80 | ch << 4, 0]) loses the top two bits of every
 * reading. A chip that sets it is handed each byte a controller exchanges
 * whole and returns the MISO for THAT byte, so it can shift the bits through
 * in order, as the silicon does. The buffer still serves a master that reads
 * MISO before its byte is in (a bit-banged one), so a chip that sets this
 * keeps a transfer armed as well. Every host that understands the field uses
 * it; the field used to be reserved, so an older chip leaves it 0 and keeps
 * the buffer contract unchanged.
 */
typedef struct {
  vx_pin   sck;
  vx_pin   mosi;
  vx_pin   miso;
  vx_pin   cs;
  uint32_t mode;     /* 0..3 (SPI mode) */
  void   (*on_done)(void* user_data, uint8_t* buffer, uint32_t count);
  void*    user_data;
  uint8_t (*on_exchange)(void* user_data, uint8_t mosi);
  uint32_t reserved[7];
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

/* ─── Named blobs (read/write byte storage) ─────────────────────────────── */

/**
 * Named byte storage the host hands the chip, and that the chip can write
 * back to. Where vx_rom_* is one read-only image baked in before setup, a blob
 * is a named buffer the chip also OWNS: a microSD model gets the card image as
 * the blob "card", serves sectors out of it, and the sectors the guest writes
 * land back in the same bytes, which is how the card panel in the editor sees
 * them.
 *
 * The rules are the same in every host that runs a chip (the browser, the
 * QEMU worker and the Linux-board host), because a model that behaves
 * differently depending on where it runs is the very thing the bus work
 * exists to remove:
 *
 *   - Storage is PER CHIP INSTANCE. Two microSD parts on the canvas each have
 *     their own "card"; nothing is shared between instances or between chips.
 *   - A blob exists only because the host declared it for this instance. An
 *     unknown name (and a NULL or empty one) has size 0, reads nothing and
 *     accepts nothing: a chip cannot bring storage into being.
 *   - A blob never grows. Its size is the device's capacity, so a write that
 *     runs off the end stops at the end, exactly as addressing a sector past
 *     the last one does on a real card.
 *   - Reads and writes are byte-exact and truncating: both copy
 *     min(len, size - offset) bytes and return how many they copied, 0 when
 *     `offset` is at or past the end. Bytes of `dst` beyond the returned
 *     count are left untouched.
 *   - A write is visible to the next read from the same instance.
 *
 * Typical use, a card model serving a 512-byte sector:
 *
 *   uint32_t n = vx_blob_read("card", sector * 512u, buf, 512u);
 *   if (n < 512u) { ... the card has no such sector ... }
 */

/** Byte length of the named blob, 0 when the host declared no such blob. */
extern uint32_t vx_blob_size(const char* name);

/** Copy up to `len` bytes from `offset` of the blob into `dst`.
 *  Returns the number of bytes copied (0 past the end or on an unknown name). */
extern uint32_t vx_blob_read(const char* name, uint32_t offset, uint8_t* dst, uint32_t len);

/** Copy up to `len` bytes from `src` into the blob at `offset`.
 *  Returns the number of bytes stored (0 past the end or on an unknown name).
 *  The blob does not grow. */
extern uint32_t vx_blob_write(const char* name, uint32_t offset, const uint8_t* src, uint32_t len);

/* ─── Lifecycle (chip exports) ──────────────────────────────────────────── */

/** Required: called once per chip instance after the simulator boots. */
void chip_setup(void);

#endif /* VELXIO_CHIP_H */
