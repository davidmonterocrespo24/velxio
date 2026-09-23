/*
 * microsd.c: the portable microSD card, SD-over-SPI, on the velxio-chip.h ABI.
 *
 * ONE model, every host. F4 of board-buses-2026-09 moves anything that drives
 * MISO next to the CPU that reads it, because QEMU asks for a byte
 * synchronously and cannot wait for the browser. The same compiled artifact is
 * therefore run by ChipRuntime.ts in the tab (local engines and the sinks),
 * by WasmChipRuntime in the ESP32 / STM32 worker, and by the Linux-board host.
 * It replaces three hand-kept twins that had already drifted apart:
 *
 *   frontend/src/simulation/parts/ProtocolParts.ts   microsd-card (JS)
 *   pro/frontend/src/pro/esp32sim/SdSpiCard.ts       the JS engines' slot (TS)
 *   backend/app/services/esp32_sd_slave.py           the QEMU worker (Python)
 *
 * What the drift cost is written into the code below: only the TS twin had
 * ACMD51 (without it no ESP-IDF app could mount), only the Python twin tracked
 * the idle bit, and the Python twin answers R1 one byte EARLY, where IDF's
 * fixed sdspi_hw_cmd_t layout cannot see it. This model is the union, so no
 * host is the odd one out.
 *
 * ── The card IS the blob ─────────────────────────────────────────────────
 *
 * The image arrives as the named blob "card" (vx_blob_* in velxio-chip.h) and
 * the guest's writes go straight back into it, which is how the SD panel in
 * the editor sees the file a sketch just wrote. A blob never grows, so the
 * card's capacity is the blob's size rounded down to whole sectors: addressing
 * past the last sector fails the way it does on real silicon instead of
 * quietly making the card bigger. No blob at all means no card in the slot,
 * and the model then never drives MISO.
 *
 * ── Two facts this project paid for; do not rediscover them ──────────────
 *
 * 1. R1 needs its N_CR fill byte IN FRONT of it. The SD spec allows 1 to 8
 *    byte times between a command and its answer, and real cards take at least
 *    one. SdFat (the SD.h of arduino-pico) throws that byte away before it
 *    starts polling, so with no fill at all it threw R1 away and no Pico
 *    sketch could mount a card. ESP-IDF is the other half of the same fact: it
 *    does not poll, `sdspi_hw_cmd_t` is a fixed layout whose r1 field is at
 *    offset 7, and `shift_cmd_response` only scans forward from there. One
 *    fill byte puts R1 exactly at offset 7 and satisfies both.
 *
 * 2. The card has to answer through the PEEK path as well as the transfer
 *    path. A bit-banged master reads MISO bit by bit and asks for the byte
 *    before the one it is clocking in has arrived. Here that is free: the
 *    answer already sits in the one-byte buffer handed to vx_spi_start, which
 *    is exactly what the host's peek reads.
 *
 * ── Why the model stays armed even while deselected ──────────────────────
 *
 * Every host clocks a device only while its chip select is active, so an armed
 * buffer is invisible until then. Keeping it armed means a host that cannot
 * deliver chip-select EDGES to a chip (the worker reaches a chip through its
 * pin map, which a wiring path may not fill in) still exchanges bytes
 * correctly; the edges are used for one thing only, ending the frame, which is
 * all a real card forgets when the host lets go of the bus.
 */
#include "velxio-chip.h"
#include <string.h>

#define SECTOR      512u
/* One queued data block is 1 + 512 + 2 bytes. Two of them never overlap in
 * practice (a host reads a block before asking for the next), and the slack
 * absorbs the R1 and fill bytes around them. */
#define RESP_CAP    2048u
#define RESP_MASK   (RESP_CAP - 1u)

/* Data-response tokens (the byte that follows a written block). */
#define DATA_ACCEPTED    0x05u
#define DATA_WRITE_ERROR 0x0Du

typedef enum {
  PH_CMD = 0,      /* idle, or clocking in a 6-byte command */
  PH_WAIT_TOKEN,   /* after CMD24/25: waiting for 0xFE / 0xFC / 0xFD */
  PH_RECV_DATA,    /* taking the 512 bytes of a block */
  PH_RECV_CRC      /* the two CRC bytes that close it */
} phase_t;

static struct {
  vx_pin sck, di, dout, cs;
  vx_spi spi;

  /* Capacity, in whole sectors, taken from the blob. 0 = empty slot. */
  uint32_t sectors;
  /* High capacity: CMD17/18/24/25 arguments are block indices, and CMD58
   * answers with CCS set. Off means SDSC and byte addressing. */
  bool hc;

  /* What the card will shift out, oldest first. */
  uint8_t resp[RESP_CAP];
  uint32_t head, tail;
  /* The byte on the wire right now: popped from the queue, handed to
   * vx_spi_start, and therefore what the host's peek reads. */
  uint8_t armed[1];

  uint8_t cmd[6];
  uint32_t cmd_len;
  bool expect_acmd;
  /* Idle from reset (CMD0) until ACMD41 completes; R1 carries the bit. */
  bool idle;
  /* CMD59: while on, the host validates the CRC16 after every data block. */
  bool crc_on;

  phase_t phase;
  uint8_t data[SECTOR];
  uint32_t data_len;
  uint32_t crc_left;
  uint32_t write_block;
  bool multi_write;
  bool multi_read;
  uint32_t read_block;

  uint8_t scratch[SECTOR];
} card;

static const char BLOB[] = "card";

/* ── Response queue ──────────────────────────────────────────────────────── */

static bool resp_empty(void) { return card.head == card.tail; }

static void resp_push(uint8_t b) {
  uint32_t next = (card.tail + 1u) & RESP_MASK;
  /* Full: drop the byte rather than eat the oldest one. A dropped tail byte
   * shows up as a short answer the host times out on; eating the head would
   * corrupt an answer already in flight. The queue is sized so this cannot
   * happen for any command sequence a host actually issues. */
  if (next == card.head) return;
  card.resp[card.tail] = b;
  card.tail = next;
}

static void resp_push_n(const uint8_t* p, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) resp_push(p[i]);
}

static void resp_clear(void) { card.head = card.tail = 0u; }

/* ── CRC ─────────────────────────────────────────────────────────────────── */

/** CRC-16-CCITT (poly 0x1021, init 0x0000) - the SD data-block CRC. */
static uint16_t crc16(const uint8_t* data, uint32_t len) {
  uint16_t crc = 0;
  for (uint32_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) {
      crc = (crc & 0x8000u) ? (uint16_t)((crc << 1) ^ 0x1021u) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

/** CRC-7 (poly 0x09) over the first 15 bytes of a CSD or CID register.
 *  Nothing in SdFat or ESP-IDF checks it, which is why the three twins all
 *  shipped a constant here; a real one cannot be wrong for a host that does. */
static uint8_t crc7(const uint8_t* data, uint32_t len) {
  uint8_t crc = 0;
  for (uint32_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) {
      crc = (crc & 0x80u) ? (uint8_t)((crc << 1) ^ 0x12u) : (uint8_t)(crc << 1);
    }
  }
  return (uint8_t)(crc >> 1);
}

/* ── Registers ───────────────────────────────────────────────────────────── */

/** R1 status byte. Only the idle bit varies for the commands modelled here. */
static uint8_t r1(void) { return card.idle ? 0x01u : 0x00u; }

/**
 * CSD. Structure v2.0 for a high-capacity card, v1.0 for a standard one,
 * because the two disagree about how capacity is encoded and a host that
 * computes the card size from the wrong one lands megabytes away.
 *
 * v1:  capacity = (C_SIZE + 1) << (C_SIZE_MULT + 2) << READ_BL_LEN
 *      with READ_BL_LEN 9 and C_SIZE_MULT 7 that is (C_SIZE + 1) * 256 KB,
 *      so C_SIZE is floored: the card never claims more than the blob holds
 *      (below 256 KB it cannot go lower than one unit, and the sectors that
 *      are not there read as zeros and refuse writes).
 * v2:  capacity = (C_SIZE + 1) * 512 KB.
 */
static void build_csd(uint8_t* c) {
  memset(c, 0, 16);
  uint64_t bytes = (uint64_t)card.sectors * SECTOR;
  c[1] = 0x26;  /* TAAC 1.5 ms */
  c[2] = 0x00;  /* NSAC */
  c[3] = 0x32;  /* TRAN_SPEED 25 MHz */
  c[4] = 0x5B;  /* CCC 0x5B5 ... */
  c[5] = 0x59;  /* ... and READ_BL_LEN = 9 (512 B) */
  if (card.hc) {
    uint32_t csize = (uint32_t)(bytes / (512u * 1024u));
    csize = csize ? csize - 1u : 0u;
    c[0] = 0x40;  /* CSD_STRUCTURE = 1 (v2.0) */
    c[7] = (uint8_t)((csize >> 16) & 0x3Fu);
    c[8] = (uint8_t)((csize >> 8) & 0xFFu);
    c[9] = (uint8_t)(csize & 0xFFu);
    c[10] = 0x7F; /* ERASE_BLK_EN, SECTOR_SIZE[6:1] */
    c[11] = 0x80; /* SECTOR_SIZE[0], WP_GRP_SIZE = 0 */
    c[12] = 0x0A; /* R2W_FACTOR = 2, WRITE_BL_LEN[3:2] */
    c[13] = 0x40; /* WRITE_BL_LEN[1:0] = 9 total */
  } else {
    uint32_t csize = (uint32_t)(bytes / (256u * 1024u));
    csize = csize ? csize - 1u : 0u;
    if (csize > 4095u) csize = 4095u;
    c[0] = 0x00; /* CSD_STRUCTURE = 0 (v1.0) */
    c[6] = (uint8_t)((csize >> 10) & 0x03u);
    c[7] = (uint8_t)((csize >> 2) & 0xFFu);
    c[8] = (uint8_t)(((csize & 0x03u) << 6) | 0x3Fu); /* + VDD_R_CURR */
    c[9] = 0xFF;  /* VDD_W_CURR, C_SIZE_MULT[2:1] */
    c[10] = 0xFF; /* C_SIZE_MULT[0] = 7, ERASE_BLK_EN, SECTOR_SIZE[6:1] */
    c[11] = 0x80; /* SECTOR_SIZE[0], WP_GRP_SIZE = 0 */
    c[12] = 0x0A; /* R2W_FACTOR = 2, WRITE_BL_LEN[3:2] */
    c[13] = 0x40; /* WRITE_BL_LEN[1:0] = 9 total */
  }
  c[15] = (uint8_t)((crc7(c, 15) << 1) | 1u);
}

/** CID. Manufacturer fields are cosmetic; no host reads them for behaviour. */
static void build_cid(uint8_t* c) {
  static const uint8_t base[15] = {
    0x01, 0x56, 0x58, 0x56, 0x45, 0x4C, 0x58, 0x53, /* mfr, "VX", "VELXS" */
    0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0x60,
  };
  memcpy(c, base, 15);
  c[15] = (uint8_t)((crc7(c, 15) << 1) | 1u);
}

/**
 * SCR, the 8-byte block ACMD51 returns. Mandatory for the ESP-IDF stack:
 * sdmmc_card_init reads it for every SD card and reads it a second time to
 * compare, and a card that answers R1 alone leaves the host clocking 0xFF
 * forever waiting for a start token. Arduino SD.h never issues ACMD51, which
 * is why two of the three twins shipped without it.
 *
 *   byte0 = SCR_STRUCTURE 0 | SD_SPEC 2 (SD 2.00, matching CMD8 and the CSD);
 *           any other structure makes the IDF driver bail.
 *   byte1 = DATA_STAT_AFTER_ERASE | SD_SECURITY 3 | BUS_WIDTHS 1-bit and 4-bit.
 */
static void build_scr(uint8_t* s) {
  memset(s, 0, 8);
  s[0] = 0x02;
  s[1] = 0x35;
}

/* ── Queueing answers ────────────────────────────────────────────────────── */

static void push_data_crc(const uint8_t* data, uint32_t len) {
  if (card.crc_on) {
    uint16_t c = crc16(data, len);
    resp_push((uint8_t)(c >> 8));
    resp_push((uint8_t)(c & 0xFFu));
  } else {
    resp_push(0xFF);
    resp_push(0xFF);
  }
}

/** A data block as the host reads it: start token, payload, CRC. */
static void push_data_block(const uint8_t* data, uint32_t len) {
  resp_push(0xFE);
  resp_push_n(data, len);
  push_data_crc(data, len);
}

/** R1 followed by a short register block (CSD, CID, SCR). */
static void push_short(const uint8_t* payload, uint32_t len) {
  resp_push(r1());
  push_data_block(payload, len);
}

/** Serve one sector out of the blob. Sectors the blob does not reach read as
 *  zeros, which is what an unwritten sector of a real card holds. */
static void push_sector(uint32_t block) {
  memset(card.scratch, 0, SECTOR);
  vx_blob_read(BLOB, block * SECTOR, card.scratch, SECTOR);
  push_data_block(card.scratch, SECTOR);
}

/* ── Commands ────────────────────────────────────────────────────────────── */

/** The block a data-transfer argument names: an index on SDHC, a byte offset
 *  on SDSC. Getting this wrong reads the right card at the wrong place. */
static uint32_t block_of(uint32_t arg) { return card.hc ? arg : (arg >> 9); }

static void process_cmd(void) {
  uint8_t code = (uint8_t)(card.cmd[0] & 0x3Fu);
  uint32_t arg = ((uint32_t)card.cmd[1] << 24) | ((uint32_t)card.cmd[2] << 16) |
                 ((uint32_t)card.cmd[3] << 8) | (uint32_t)card.cmd[4];
  bool is_acmd = card.expect_acmd;
  uint8_t reg[16];
  card.expect_acmd = false;

  if (is_acmd) {
    switch (code) {
      case 41: /* ACMD41 SD_SEND_OP_COND: ready, and out of idle */
        card.idle = false;
        resp_push(0x00);
        return;
      case 13: /* ACMD13 SD status (R2) */
        resp_push(0x00);
        resp_push(0x00);
        return;
      case 51: /* ACMD51 SEND_SCR */
        build_scr(reg);
        push_short(reg, 8);
        return;
      default:
        break; /* anything else falls through to the plain command table */
    }
  }

  switch (code) {
    case 0: /* GO_IDLE_STATE */
      card.idle = true;
      resp_push(0x01);
      break;
    case 8: /* SEND_IF_COND: R7 = R1 plus the echo-back */
      resp_push(r1());
      resp_push(0x00);
      resp_push(0x00);
      resp_push(0x01);
      resp_push(0xAA);
      break;
    case 9: /* SEND_CSD */
      build_csd(reg);
      push_short(reg, 16);
      break;
    case 10: /* SEND_CID */
      build_cid(reg);
      push_short(reg, 16);
      break;
    case 12: /* STOP_TRANSMISSION, ends CMD18 */
      /* The continuous-read refill has the next block queued behind the one
       * the host is reading. Flush it, or the R1b lands after 515 bytes of
       * data the host never asked for. The fill byte goes back in because the
       * flush dropped the one the frame had just queued. */
      card.multi_read = false;
      resp_clear();
      resp_push(0xFF);
      resp_push(0x00); /* R1b */
      resp_push(0x00); /* busy */
      resp_push(0xFF); /* ready again */
      break;
    case 13: /* SEND_STATUS (R2) */
      resp_push(r1());
      resp_push(0x00);
      break;
    case 16: /* SET_BLOCKLEN: the block length is fixed at 512 */
      resp_push(r1());
      break;
    case 17: /* READ_SINGLE_BLOCK */
      resp_push(0x00);
      push_sector(block_of(arg));
      break;
    case 18: /* READ_MULTIPLE_BLOCK: stream until CMD12 */
      resp_push(0x00);
      card.read_block = block_of(arg);
      card.multi_read = true;
      push_sector(card.read_block);
      card.read_block++;
      break;
    case 24: /* WRITE_BLOCK: one data block follows */
      resp_push(0x00);
      card.write_block = block_of(arg);
      card.multi_write = false;
      card.phase = PH_WAIT_TOKEN;
      break;
    case 25: /* WRITE_MULTIPLE_BLOCK: blocks follow until the stop token */
      resp_push(0x00);
      card.write_block = block_of(arg);
      card.multi_write = true;
      card.phase = PH_WAIT_TOKEN;
      break;
    case 55: /* APP_CMD: the next command is an ACMD */
      resp_push(r1());
      card.expect_acmd = true;
      break;
    case 58: /* READ_OCR: powered up, CCS says which addressing is in force */
      resp_push(r1());
      resp_push(card.hc ? 0xC0u : 0x80u);
      resp_push(0xFF);
      resp_push(0x80);
      resp_push(0x00);
      break;
    case 59: /* CRC_ON_OFF */
      card.crc_on = (arg & 1u) != 0u;
      resp_push(r1());
      break;
    default: /* accept and acknowledge anything else */
      resp_push(r1());
      break;
  }
}

/** Commit the block just clocked in. A write that runs off the end of the
 *  blob is refused rather than dropped in silence: the card is exactly as big
 *  as its image, and a host that keeps writing past the end has to hear so. */
static void commit_write(void) {
  uint32_t stored =
    vx_blob_write(BLOB, card.write_block * SECTOR, card.data, SECTOR);
  card.write_block++;
  resp_push(stored == SECTOR ? DATA_ACCEPTED : DATA_WRITE_ERROR);
}

/* ── The byte path ───────────────────────────────────────────────────────── */

/** One MOSI byte, after its MISO answer has already gone out. */
static void consume(uint8_t mosi) {
  switch (card.phase) {
    case PH_CMD:
      if (card.cmd_len == 0u) {
        if ((mosi & 0xC0u) == 0x40u) {
          card.cmd[0] = mosi; /* a command starts with bit7 = 0, bit6 = 1 */
          card.cmd_len = 1u;
        } else if (card.multi_read && resp_empty()) {
          /* Continuous read: the host is clocking 0xFF for the next block. */
          push_sector(card.read_block);
          card.read_block++;
        }
      } else {
        card.cmd[card.cmd_len++] = mosi;
        if (card.cmd_len == 6u) {
          /* N_CR: the fill byte that puts R1 at offset 7. See the header. */
          resp_push(0xFF);
          process_cmd();
          card.cmd_len = 0u;
        }
      }
      break;
    case PH_WAIT_TOKEN:
      if (mosi == 0xFEu || mosi == 0xFCu) {
        card.phase = PH_RECV_DATA;
        card.data_len = 0u;
      } else if (mosi == 0xFDu) { /* stop token, ends CMD25 */
        card.multi_write = false;
        card.phase = PH_CMD;
        resp_push(0x00);
      }
      /* anything else is the 0xFF gap before the token */
      break;
    case PH_RECV_DATA:
      card.data[card.data_len++] = mosi;
      if (card.data_len == SECTOR) {
        card.phase = PH_RECV_CRC;
        card.crc_left = 2u;
      }
      break;
    case PH_RECV_CRC:
      if (--card.crc_left == 0u) {
        commit_write();
        card.phase = card.multi_write ? PH_WAIT_TOKEN : PH_CMD;
      }
      break;
  }
}

/** Put the next answer on the wire. Popping here rather than in the completion
 *  is what makes the host's peek right: the byte a bit-banged master reads
 *  ahead of the clock is the byte this buffer holds. */
static void arm(void) {
  if (card.sectors == 0u) return; /* empty slot: nothing drives MISO */
  if (resp_empty()) {
    card.armed[0] = 0xFF;
  } else {
    card.armed[0] = card.resp[card.head];
    card.head = (card.head + 1u) & RESP_MASK;
  }
  vx_spi_start(card.spi, card.armed, 1u);
}

/**
 * The host let go of the bus. A command frame half clocked in cannot be
 * finished by bytes meant for the next chip, and an answer nobody stayed to
 * read is gone. That is ALL a real card forgets here: a multiple-block
 * transfer survives on purpose, because SdFat releases chip select between
 * writeStart / writeData / writeStop and expects the card to still be in its
 * data phase when it comes back, and the APP_CMD flag of a CMD55 belongs to
 * the next command, which SdFat clocks after deselecting.
 */
static void end_frame(void) {
  card.cmd_len = 0u;
  resp_clear();
}

static void on_done(void* ud, uint8_t* buffer, uint32_t count) {
  (void)ud;
  if (count == 0u) {
    /* vx_spi_stop: the host ended the exchange (chip select released, or the
     * MCU was reset). Re-arm, or the card would go quiet for good. */
    end_frame();
    arm();
    return;
  }
  consume(buffer[0]);
  arm();
}

static void on_cs(void* ud, vx_pin pin, int value) {
  (void)ud;
  (void)pin;
  if (value == VX_HIGH) { /* deselected: chip select is active low */
    end_frame();
    arm();
  }
}

void chip_setup(void) {
  /* The card is the blob, so its capacity is settled before anything else.
   * A host that only wired the storage up after chip_setup would leave an
   * empty slot here, which is exactly what the tests check. */
  card.sectors = vx_blob_size(BLOB) / SECTOR;

  /* Addressing follows capacity: SDSC up to 2 GB, SDHC above it. The
   * attribute exists so the other mode can be exercised (and a card-type
   * report reproduced) without a two-gigabyte image: -1 auto, 0 SDSC, 1 SDHC. */
  vx_attr a_hc = vx_attr_register("sdhc", -1);
  double hc = vx_attr_read(a_hc);
  card.hc = hc < 0 ? ((uint64_t)card.sectors * SECTOR > 2ull * 1024 * 1024 * 1024)
                   : (hc >= 0.5);

  card.idle = true;
  card.phase = PH_CMD;

  /* Silkscreen names of a microSD breakout, which is what the wiring speaks. */
  card.sck = vx_pin_register("SCK", VX_INPUT);
  card.di = vx_pin_register("DI", VX_INPUT);
  /* DAT3 carries the card's own pull-up, so a slot whose select nothing drives
   * reads as deselected and the card stays quiet. */
  card.cs = vx_pin_register("CS", VX_INPUT_PULLUP);
  /* Plain VX_OUTPUT, not OUTPUT_HIGH: the data-out leg is driven by the bus
   * during a transfer, and an initial level here would push a level onto the
   * board's MISO pad before any host has clocked a bit. */
  card.dout = vx_pin_register("DO", VX_OUTPUT);

  vx_spi_config cfg = {
    .sck = card.sck,
    .mosi = card.di,
    .miso = card.dout,
    .cs = card.cs,
    /* SD cards clock on modes 0 and 3, but vx_spi_config carries ONE mode, so
     * the card declares 0 and a mode-3 master is reported as a mismatch it
     * would not be on the bench. The three twins this model replaces declared
     * both; closing the gap means widening the chip ABI, not lying here. */
    .mode = 0,
    .on_done = on_done,
    .user_data = 0,
  };
  card.spi = vx_spi_attach(&cfg);
  vx_pin_watch(card.cs, VX_EDGE_RISING, on_cs, 0);

  arm();
}
