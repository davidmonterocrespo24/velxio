# Custom Chips — C API Reference

Complete reference for `velxio-chip.h`. Every function, struct, enum, and
constant the chip can use.

The header is shipped at:

- `backend/sdk/velxio-chip.h` — bundled with the backend Docker image
- `test/test_custom_chips/sdk/include/velxio-chip.h` — local sandbox copy

Both are kept in sync; either works as the include path.

---

## Table of contents

- [Lifecycle](#lifecycle)
- [Pins](#pins)
- [Attributes](#attributes)
- [I2C slave](#i2c-slave)
- [SPI slave](#spi-slave)
- [UART](#uart)
- [Timers and time](#timers-and-time)
- [Display / framebuffer](#display--framebuffer)
- [Logging](#logging)
- [Type & constant cheat sheet](#type--constant-cheat-sheet)
- [ABI guarantees](#abi-guarantees)

---

## Lifecycle

```c
void chip_setup(void);
```

Required, exported. Called **once per chip instance** when the simulation
starts. Allocate state, register pins, attach peripherals, and subscribe to
events here. Do not loop.

---

## Pins

### Types and constants

```c
typedef int32_t vx_pin;          // Opaque handle returned by vx_pin_register
#define VX_INPUT          0
#define VX_OUTPUT         1
#define VX_INPUT_PULLUP   2
#define VX_INPUT_PULLDOWN 3
#define VX_ANALOG         4
#define VX_OUTPUT_LOW     16     // Initialize the wired pin LOW at register time
#define VX_OUTPUT_HIGH    17     // Initialize the wired pin HIGH at register time

#define VX_LOW  0
#define VX_HIGH 1

#define VX_EDGE_RISING  1
#define VX_EDGE_FALLING 2
#define VX_EDGE_BOTH    3
```

Use `VX_OUTPUT_LOW` / `VX_OUTPUT_HIGH` instead of `VX_OUTPUT` when you want
the pin to power up at a known level. This eliminates the brief window
between `vx_pin_register` and your first `vx_pin_write` during which a plain
`VX_OUTPUT` pin would default to LOW.

### `vx_pin_register`

```c
vx_pin vx_pin_register(const char* name, vx_pin_mode mode);
```

Register a logical pin on the chip. `name` is what appears on the schematic
and what the diagram editor uses to wire your chip. Returns an opaque handle
you'll pass to all other pin functions.

Call only from `chip_setup()`.

```c
chip_state_t* s = malloc(sizeof(chip_state_t));
s->in  = vx_pin_register("IN",  VX_INPUT);
s->out = vx_pin_register("OUT", VX_OUTPUT_LOW);   // starts LOW, no glitch
```

### `vx_pin_read`

```c
int vx_pin_read(vx_pin p);
```

Returns the digital state of a pin: `0` (LOW) or `1` (HIGH). If the pin
isn't wired to anything in the diagram, returns `0`.

### `vx_pin_write`

```c
void vx_pin_write(vx_pin p, int value);
```

Drive an OUTPUT pin to `value` (0 or 1). The host propagates the change
through the wiring graph immediately — any other chip with a `pin_watch` on
the wired pin will see the edge.

### `vx_pin_read_analog`

```c
double vx_pin_read_analog(vx_pin p);
```

Read the analog voltage of a pin (0.0 V – 5.0 V on AVR, 0.0 V – 3.3 V on
ESP32). Used by ADC chips to sample voltages from potentiometers or sensors.

### `vx_pin_dac_write`

```c
void vx_pin_dac_write(vx_pin p, double voltage);
```

Drive an analog voltage on a pin. Used by DAC chips.

### `vx_pin_set_mode`

```c
void vx_pin_set_mode(vx_pin p, vx_pin_mode mode);
```

Change a pin's direction after registration — useful for bidirectional
buses (e.g. open-drain protocols where you switch between input and output).

### `vx_pin_watch`

```c
void vx_pin_watch(
  vx_pin p,
  vx_edge edge,
  void (*cb)(void* user_data, vx_pin pin, int value),
  void* user_data
);
```

Subscribe to edge events on a pin. The callback fires when the pin's state
crosses the requested edge:

| `edge` | Fires on |
|---|---|
| `VX_EDGE_RISING`  | LOW → HIGH only |
| `VX_EDGE_FALLING` | HIGH → LOW only |
| `VX_EDGE_BOTH`    | every transition |

Inside the callback you have access to the pin handle, the new value, and
your `user_data` pointer (typically a pointer to your chip's state struct).

```c
static void on_clk(void *ud, vx_pin pin, int value) {
  chip_state_t *s = (chip_state_t*)ud;
  if (value) {                              // rising edge
    s->shift_register <<= 1;
    s->shift_register |= vx_pin_read(s->data);
  }
}

vx_pin_watch(clk_pin, VX_EDGE_RISING, on_clk, s);
```

### `vx_pin_watch_stop`

```c
void vx_pin_watch_stop(vx_pin p);
```

Cancels every watch registered for the given pin. Useful when entering a
mode where the chip should ignore inputs (e.g. powered-down state).

---

## Attributes

User-editable parameters. Design-time defaults live in the part inspector
(right-click the chip). On velxio.dev (Pro) a chip's attributes can also be
driven by live controls while the simulation runs; the OSS build reads the
values saved on the component.

### Schema in `chip.json`

```json
"attributes": [
  { "name": "threshold", "label": "Pulses",  "type": "int",   "default": 4,    "min": 1, "max": 1024 },
  { "name": "gain",      "label": "Gain",    "type": "float", "default": 1.0,  "min": 0, "max": 10, "step": 0.1 }
]
```

| Field | Effect |
|---|---|
| `name` | Internal key — what the chip uses in `vx_attr_register` |
| `label` | Human-readable text shown next to the slider |
| `type` | `int` rounds to integer; `float`/`number` keeps decimals |
| `default` | Initial value |
| `min`/`max` | If both present, a slider is shown |
| `step` | Step size (default 1 for int, 0.01 for float) |

### `vx_attr_register`

```c
vx_attr vx_attr_register(const char* name, double default_val);
```

Register an attribute. Returns a handle. The default in `chip.json` takes
precedence over the C-side default if both are set — the C-side default
applies when an instance has no saved value yet.

### `vx_attr_read`

```c
double vx_attr_read(vx_attr a);
```

Read the current value. **Always re-read** inside callbacks — the user can
change the slider while the simulation runs and your chip should pick up
the new value on the next event.

```c
static void on_pulse(void* ud, vx_pin pin, int value) {
  chip_state_t* s = (chip_state_t*)ud;
  s->count++;
  uint32_t threshold = (uint32_t)vx_attr_read(s->threshold);    // re-read live
  if (s->count >= threshold) {
    s->count = 0;
    vx_pin_write(s->out, !s->state);
    s->state = !s->state;
  }
}
```

---

## I2C slave

Velxio routes I2C bus events from the master (the Arduino sketch's
`Wire.beginTransmission(addr)`) to your chip when the address matches.

### Config struct

```c
typedef struct {
  uint8_t  address;       /* 7-bit I2C address */
  uint8_t  _pad[3];
  vx_pin   scl;
  vx_pin   sda;
  bool   (*on_connect)(void* user_data, uint8_t addr, bool is_read);
  uint8_t(*on_read)   (void* user_data);
  bool   (*on_write)  (void* user_data, uint8_t byte);
  void   (*on_stop)   (void* user_data);
  void*    user_data;
  uint32_t reserved[8];
} vx_i2c_config;
_Static_assert(sizeof(vx_i2c_config) == 64, "vx_i2c_config must be 64 bytes");
```

### `vx_i2c_attach`

```c
vx_i2c vx_i2c_attach(const vx_i2c_config* cfg);
```

Attach an I2C slave. Call only from `chip_setup()`. Two instances of the
same chip with different `A0`/`A1`/`A2` settings can coexist — they get
different addresses.

### Callbacks

```c
bool on_connect(void* ud, uint8_t addr, bool is_read);
```
The master started a transaction. Return `true` for ACK, `false` for NACK.
For most chips: just `return true;`. `is_read` tells you whether the master
is about to read or write.

```c
uint8_t on_read(void* ud);
```
The master is reading a byte from your chip. Return the byte to put on
SDA. Called once per byte the master clocks out.

```c
bool on_write(void* ud, uint8_t byte);
```
The master sent a byte. Return `true` to ACK, `false` to NACK (e.g. memory
full).

```c
void on_stop(void* ud);
```
The master issued STOP. Reset any "transaction in progress" state your
chip has — the next `on_connect` is a fresh transaction.

### Example: 24C01 EEPROM

```c
typedef enum { ST_IDLE, ST_HAS_POINTER } ee_state;

typedef struct {
  uint8_t  pointer;
  uint8_t  mem[128];
  ee_state state;
} chip_state_t;

static bool i2c_connect(void* ud, uint8_t addr, bool is_read) {
  chip_state_t* s = ud;
  if (!is_read) s->state = ST_IDLE;     // fresh write transaction
  return true;
}

static uint8_t i2c_read(void* ud) {
  chip_state_t* s = ud;
  uint8_t b = s->mem[s->pointer & 0x7f];
  s->pointer++;
  return b;
}

static bool i2c_write(void* ud, uint8_t byte) {
  chip_state_t* s = ud;
  if (s->state == ST_IDLE) {
    s->pointer = byte;
    s->state = ST_HAS_POINTER;
  } else {
    s->mem[s->pointer & 0x7f] = byte;
    s->pointer++;
  }
  return true;
}

void chip_setup(void) {
  chip_state_t* s = calloc(1, sizeof(chip_state_t));
  vx_i2c_config cfg = {
    .address    = 0x50,
    .scl        = vx_pin_register("SCL", VX_INPUT),
    .sda        = vx_pin_register("SDA", VX_INPUT),
    .on_connect = i2c_connect,
    .on_read    = i2c_read,
    .on_write   = i2c_write,
    .on_stop    = NULL,            // optional
    .user_data  = s,
  };
  vx_i2c_attach(&cfg);
}
```

---

## SPI slave

Buffer-based bidirectional transfer model. The chip pre-fills a buffer with
the bytes to send on MISO; the bus overwrites those bytes with what it
received on MOSI.

### Config struct

```c
typedef struct {
  vx_pin   sck;
  vx_pin   mosi;
  vx_pin   miso;
  vx_pin   cs;          /* the bus honours it: no bytes while deasserted.
                           ((vx_pin)-1) = the chip has no select line */
  uint32_t mode;        /* 0..3 */
  void   (*on_done)(void* user_data, uint8_t* buffer, uint32_t count);
  void*    user_data;
  uint32_t reserved[8];
} vx_spi_config;
_Static_assert(sizeof(vx_spi_config) == 60, "vx_spi_config must be 60 bytes");
```

### Functions

```c
vx_spi vx_spi_attach(const vx_spi_config* cfg);
void   vx_spi_start (vx_spi s, uint8_t* buffer, uint32_t count);
void   vx_spi_stop  (vx_spi s);
```

### How it works

1. `vx_spi_attach` registers the chip on the bus.
2. The chip calls `vx_spi_start(handle, buf, N)` to say "I want to exchange
   N bytes; here's my MISO data."
3. As the master clocks bytes, byte by byte:
   - the master's MOSI byte overwrites `buf[i]`
   - the chip's `buf[i]` (its MISO data) is shifted out to the master
4. After N bytes, `on_done(buf, N)` fires. `buf` now contains the N MOSI
   bytes the master sent.

### Re-arming

The chip is **not** automatically armed for the next transfer. Call
`vx_spi_start` again inside `on_done` if you want continuous transfer:

```c
static void on_spi_done(void* ud, uint8_t* buffer, uint32_t count) {
  chip_state_t* s = ud;
  s->shift_reg = buffer[0];
  vx_spi_start(s->spi, s->buf, 1);   // re-arm for next byte
}
```

This is needed for chips like 74HC595 that have no real CS — they shift
on every SCK edge as long as data flows.

### Using CS for transaction boundaries

For chips with a real chip-select (e.g. MCP3008), the chip watches its CS
pin and triggers `vx_spi_start` / `vx_spi_stop` accordingly:

```c
static void on_cs_change(void* ud, vx_pin pin, int value) {
  chip_state_t* s = ud;
  if (value == VX_LOW) {
    vx_spi_start(s->spi, s->buf, 3);   // CS asserted — start exchange
  } else {
    vx_spi_stop(s->spi);                // CS released
  }
}

vx_pin_watch(s->cs, VX_EDGE_BOTH, on_cs_change, s);
```

---

## UART

### Config struct

```c
typedef struct {
  vx_pin   rx;
  vx_pin   tx;
  uint32_t baud_rate;
  void   (*on_rx_byte) (void* user_data, uint8_t byte);
  void   (*on_tx_done) (void* user_data);
  void*    user_data;
  uint32_t reserved[8];
} vx_uart_config;
_Static_assert(sizeof(vx_uart_config) == 56, "vx_uart_config must be 56 bytes");
```

### Functions

```c
vx_uart vx_uart_attach(const vx_uart_config* cfg);
bool    vx_uart_write (vx_uart u, const uint8_t* buffer, uint32_t count);
```

### Example: ROT13 chip

```c
static void on_rx(void* ud, uint8_t byte) {
  chip_state_t* s = ud;
  uint8_t out = byte;
  if (out >= 'A' && out <= 'Z') out = ((out - 'A' + 13) % 26) + 'A';
  if (out >= 'a' && out <= 'z') out = ((out - 'a' + 13) % 26) + 'a';
  vx_uart_write(s->uart, &out, 1);    // echo back transformed byte
}

void chip_setup(void) {
  chip_state_t* s = malloc(sizeof(chip_state_t));
  vx_uart_config cfg = {
    .rx          = vx_pin_register("RX", VX_INPUT),
    .tx          = vx_pin_register("TX", VX_INPUT_PULLUP),
    .baud_rate   = 115200,
    .on_rx_byte  = on_rx,
    .on_tx_done  = NULL,
    .user_data   = s,
  };
  s->uart = vx_uart_attach(&cfg);
}
```

When the user wires the chip's `RX` pin to the Arduino's pin 1 (TX0), the
host bridges them automatically: every byte the sketch sends with
`Serial.write()` triggers your `on_rx` callback. Your `vx_uart_write` calls
land in `Serial.read()`'s buffer.

---

## Timers and time

```c
uint64_t vx_sim_now_nanos(void);

vx_timer vx_timer_create(void (*cb)(void* user_data), void* user_data);
void     vx_timer_start (vx_timer t, uint64_t period_nanos, bool repeat);
void     vx_timer_stop  (vx_timer t);
```

Timer ticks are anchored to **simulated time** — they fire deterministically
relative to CPU cycles, not wall-clock seconds. A 1-ms timer will fire after
exactly 1 ms of simulated AVR time regardless of how fast the host actually runs.

```c
static void on_tick(void* ud) {
  chip_state_t* s = ud;
  vx_pin_write(s->led, !vx_pin_read(s->led));   // blink at 1 Hz
}

void chip_setup(void) {
  chip_state_t* s = malloc(sizeof(chip_state_t));
  s->led = vx_pin_register("LED", VX_OUTPUT_LOW);
  vx_timer t = vx_timer_create(on_tick, s);
  vx_timer_start(t, 500000000, true);    // 500 ms, repeating
}
```

---

## Display / framebuffer

For chips that drive a screen.

### Schema in `chip.json`

```json
"display": { "width": 128, "height": 64 }
```

Adding this enables a `<canvas>` inside the chip's web component on the
canvas. The chip writes RGBA pixels to a framebuffer; the host repaints the
canvas after each write.

### Functions

```c
typedef int32_t vx_buffer;

vx_buffer vx_framebuffer_init(uint32_t* out_width, uint32_t* out_height);
void      vx_buffer_write    (vx_buffer buf, uint32_t offset, const void* data, uint32_t data_len);
```

### Pixel format

Row-major RGBA8888, no padding. Pixel `(x, y)` lives at byte offset
`(y * width + x) * 4`, bytes `R G B A`.

### Example

```c
uint32_t w, h;
vx_buffer fb = vx_framebuffer_init(&w, &h);

// Fill the screen green
uint8_t green[4] = {0, 0xFF, 0, 0xFF};
for (uint32_t y = 0; y < h; y++) {
  for (uint32_t x = 0; x < w; x++) {
    vx_buffer_write(fb, (y * w + x) * 4, green, 4);
  }
}
```

For real LCDs you typically convert RGB565 → RGBA8888 inline before writing.

---

## Logging

```c
void vx_log(const char* msg);
```

Print a message to the host's chip log (browser dev console, prefixed with
`[chip:<componentId>]`).

`printf` also works — it's routed through WASI's `fd_write` syscall to the
same log.

```c
vx_log("EEPROM ready");
printf("Temperature: %.2f °C\n", temp);
```

---

## Type & constant cheat sheet

```c
// Opaque handles (all int32_t under the hood)
vx_pin    // pin handle
vx_attr   // attribute handle
vx_i2c    // I2C device handle
vx_uart   // UART handle
vx_spi    // SPI handle
vx_timer  // timer handle
vx_buffer // framebuffer handle

// Pin modes
VX_INPUT, VX_OUTPUT, VX_INPUT_PULLUP, VX_INPUT_PULLDOWN, VX_ANALOG
VX_OUTPUT_LOW, VX_OUTPUT_HIGH

// Pin values
VX_LOW (0), VX_HIGH (1)

// Edge mask (combine with bitwise OR if needed)
VX_EDGE_RISING (1), VX_EDGE_FALLING (2), VX_EDGE_BOTH (3)
```

---

## ABI guarantees

These are checked at compile time inside the header:

- `sizeof(vx_i2c_config)  == 64`
- `sizeof(vx_uart_config) == 56`
- `sizeof(vx_spi_config)  == 60`

If any of these change, your chip won't compile until the runtime side is
updated to match. This is intentional — it catches ABI drift early.

Each config struct also has a `uint32_t reserved[8]` field at the end. Zero
it out (the Velxio header initializer literally `= {.field = ...}` syntax
zeros unmentioned fields). Future versions may use those slots; today they
must be 0.
