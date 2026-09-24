/**
 * The microSD card, SD-over-SPI: ONE JavaScript model for every host in this
 * tab (project board-buses-2026-09, F4).
 *
 * Until F4 this card existed three times: this model (born in the pro overlay
 * for the in-browser ESP32 engines), a second state machine inside the OSS
 * `microsd-card` part, and a third in Python for the QEMU worker
 * (`esp32_sd_slave.py`). They had already drifted: only this one had ACMD51
 * (without it no ESP-IDF app could mount), only the Python one tracked the
 * idle bit, and the Python one answered R1 one byte early, where IDF's fixed
 * `sdspi_hw_cmd_t` layout cannot see it.
 *
 * So the most complete of the three was moved here, to OSS, where the canvas
 * part and a board's built-in slot both reach it, and the other two were
 * retired: the Python one by the portable model that now runs beside the guest
 * (`buses/models/microsd.c`), the part's own by this file.
 *
 * Three hard-won details, all of them paid for once:
 *
 *  - reply-FIRST: the MISO shifted out for a transfer was prepared by EARLIER
 *    bytes (full-duplex). transfer() returns the queued byte, THEN consumes
 *    the new MOSI. This gives the Ncr command->response latency SD hosts
 *    expect: R1 arrives on the 0xFF clocks the host sends AFTER the six
 *    command bytes (the classic "poll for R1" loop), never on the command's
 *    last byte. Ncr is TWO byte times (see pushNcr) - a 1-byte Ncr answers at
 *    offset 6, which ESP-IDF's fixed sdspi_hw_cmd_t layout cannot see.
 *  - SDSC byte addressing: CMD17/18/24/25 args are byte offsets (block*512);
 *    the card presents SDSC (CMD58 CCS=0) and translates `arg >> 9` -> block.
 *  - the write data phase (token 0xFE/0xFC + 512 bytes + CRC) is captured.
 *
 * Command set (what SD.h / SdFat / ESP-IDF sdspi actually use):
 *   CMD0 GO_IDLE (R1=0x01), CMD8 SEND_IF_COND (R7), CMD9 CSD, CMD10 CID,
 *   CMD12 STOP_TRANSMISSION, CMD13 STATUS (R2), CMD16 SET_BLOCKLEN,
 *   CMD17/18 read single/multiple, CMD24/25 write single/multiple,
 *   CMD55+ACMD41 init (leaves idle), ACMD13, ACMD51 SEND_SCR (IDF reads the
 *   SCR on every SD card; SD.h never does), CMD58 READ_OCR (R3, CCS=0),
 *   CMD59 CRC_ON_OFF (real CRC16-CCITT on data blocks when enabled - the
 *   ESP-IDF sdspi host validates it; Arduino SD.h leaves CRC off).
 *
 * Bus interface: the bus fabric's `SpiDevice`, through {@link sdSpiFabricDevice}.
 * The fabric is what decides the card is selected: it hands the model only the
 * frames clocked while the card's own chip select is active and calls
 * select()/deselect() on its edges, so the CS-keyed router this file used to
 * carry (`SdSpiBusRouter`, one card stacked in front of the display path in
 * every bridge) is gone, and with it the always-selected fallback that made a
 * card with an unwired CS swallow the whole bus and blank the board's panel.
 *
 * `setCs()` stays as the model's own gate, driven by the fabric's select /
 * deselect: letting go of CS ends the transaction, which a real card does too.
 *
 * On a board whose CPU runs in a QEMU worker this model answers nobody: the
 * worker reads MISO synchronously and cannot wait for the tab. There the card
 * is the portable model in the bus map ({@link sdCardRemoteModel}), and this
 * copy only follows the MOSI the worker relays back, which is what keeps the
 * card panel showing what the guest wrote.
 */

import { busChipB64, bytesToBase64, loadBusChip } from '../buses/busChips';
import type { RemoteSpiModel, SpiDevice } from '../buses/types';

const BLOCK = 512;

type Phase = 'cmd' | 'wait-token' | 'recv-data' | 'recv-crc';

/** CRC-16-CCITT (poly 0x1021, init 0x0000) - the SD data-block CRC. */
export function sdCrc16(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export class SdSpiCard {
  /** Sparse backing store: blockIndex -> 512-byte sector (unwritten = zeros). */
  private readonly store = new Map<number, Uint8Array>();
  private readonly cSize: number; // CSD v2 C_SIZE

  // Response queue (index-based pop: 512-byte blocks make shift() wasteful).
  private resp: number[] = [];
  private respHead = 0;

  // SD SPI command state machine.
  private cmd: number[] = [];
  private expectAcmd = false;
  /** Idle from reset (CMD0) until ACMD41 completes; R1 carries the idle bit. */
  private idle = true;
  private crcEnabled = false;
  private phase: Phase = 'cmd';
  private data: number[] = [];
  private crcLeft = 0;
  private writeAddr = 0;
  private multiWrite = false;
  private multiRead = false;
  private readAddr = 0;

  /** CS asserted (card selected). Default true: a card whose CS was never
   *  wired has no bus to share and answers everything, as it always did. */
  private cs = true;

  constructor(image?: Uint8Array | null, cardBytes = 64 * 1024 * 1024) {
    this.cSize = Math.floor(cardBytes / (512 * 1024)) - 1;
    if (image) this.loadImage(image);
  }

  // ── CS (active-low pin; the bridge calls setCs(!gpioLevel)) ───────────────

  /** True while the card's CS is asserted (the card answers the bus). */
  get selected(): boolean {
    return this.cs;
  }

  setCs(asserted: boolean): void {
    // Letting go of CS ends the transaction. A real card stops driving MISO
    // and never sees the rest, so a command frame still being clocked in
    // cannot be finished by bytes the host meant for the display on the same
    // wires, and a reply nobody stayed to read is gone. What the card IS -
    // idle bit, CRC mode, the block it is streaming - survives: deselecting
    // is not a reset. Mirror of the QEMU worker's SdSpiSlave.deselect().
    if (this.cs && !asserted) {
      this.cmd = [];
      this.resp = [];
      this.respHead = 0;
    }
    this.cs = asserted;
  }

  // ── Backing store ─────────────────────────────────────────────────────────

  loadImage(image: Uint8Array): void {
    for (let i = 0; i * BLOCK < image.length; i++) {
      const chunk = image.subarray(i * BLOCK, (i + 1) * BLOCK);
      if (chunk.some((b) => b !== 0)) {
        // skip all-zero blocks -> sparse
        const blk = new Uint8Array(BLOCK);
        blk.set(chunk);
        this.store.set(i, blk);
      }
    }
  }

  /**
   * Put `data` at byte `offset`, as the model beside a remote guest wrote it
   * (`bus_blob`). The span is whatever the model touched, so it may start or
   * end inside a sector.
   */
  writeBytes(offset: number, data: Uint8Array): void {
    let done = 0;
    while (done < data.length) {
      const at = offset + done;
      const idx = Math.floor(at / BLOCK);
      const within = at - idx * BLOCK;
      const n = Math.min(BLOCK - within, data.length - done);
      let blk = this.store.get(idx);
      if (!blk) {
        blk = new Uint8Array(BLOCK);
        this.store.set(idx, blk);
      }
      blk.set(data.subarray(done, done + n), within);
      done += n;
    }
  }

  /** Reassemble the card's CURRENT contents (initial image + every write the
   *  guest made) into a flat image. `minBytes` pads the dump to at least the
   *  original volume size so a FAT parser sees the full filesystem even when
   *  the tail blocks were never written. */
  dumpImage(minBytes = 0): Uint8Array {
    let maxBlock = Math.ceil(minBytes / BLOCK) - 1;
    for (const idx of this.store.keys()) {
      if (idx > maxBlock) maxBlock = idx;
    }
    const out = new Uint8Array((maxBlock + 1) * BLOCK);
    for (const [idx, blk] of this.store) {
      out.set(blk, idx * BLOCK);
    }
    return out;
  }

  private readBlock(idx: number): Uint8Array {
    return this.store.get(idx) ?? new Uint8Array(BLOCK);
  }

  private writeBlock(idx: number, data: number[]): void {
    const blk = new Uint8Array(BLOCK);
    for (let i = 0; i < Math.min(data.length, BLOCK); i++) blk[i] = data[i] & 0xff;
    this.store.set(idx, blk);
  }

  /** Serialise the (possibly firmware-modified) store back to an image. */
  toImage(): Uint8Array {
    if (this.store.size === 0) return new Uint8Array(0);
    let top = 0;
    for (const idx of this.store.keys()) top = Math.max(top, idx + 1);
    const out = new Uint8Array(top * BLOCK);
    for (const [idx, blk] of this.store) out.set(blk, idx * BLOCK);
    return out;
  }

  // ── Response helpers ──────────────────────────────────────────────────────

  private push(...bytes: number[]): void {
    this.resp.push(...bytes);
  }

  /**
   * Queue the Ncr dead byte that precedes every command response.
   *
   * The SD spec allows Ncr (command -> response latency) to be 1-8 byte times.
   * We used to answer on the FIRST 0xFF after the six command bytes (offset 6),
   * which Arduino SD.h happily accepts because it POLLS for the first non-0xFF.
   * ESP-IDF's sdspi host does NOT poll: `sdspi_hw_cmd_t` is a FIXED layout -
   * byte 6 is `ncr` ("dead time"), byte 7 is `r1` - and `shift_cmd_response()`
   * starts scanning at `&cmd->r1` (offset 7) and only moves FORWARD. A response
   * landing at offset 6 is therefore invisible to it: every command returned
   * ESP_ERR_NOT_FOUND -> ESP_ERR_TIMEOUT (0x107) and no IDF app could mount the
   * card. One dead byte puts R1 at offset 7: still spec-legal, still fine for
   * SD.h's poll loop, and readable by IDF's fixed layout.
   */
  private pushNcr(): void {
    this.push(0xff);
  }

  private popResp(): number {
    if (this.respHead >= this.resp.length) return 0xff;
    const b = this.resp[this.respHead++];
    if (this.respHead === this.resp.length) {
      this.resp = [];
      this.respHead = 0;
    }
    return b;
  }

  private respEmpty(): boolean {
    return this.respHead >= this.resp.length;
  }

  /** What the card will shift out on its NEXT frame, without consuming it.
   *  A bit-banged master reads MISO bit by bit before the byte it is clocking
   *  in has arrived, so the fabric's software decoder asks for this. */
  peekResponse(): number {
    return this.respHead < this.resp.length ? this.resp[this.respHead] : 0xff;
  }

  private pushDataCrc(data: Uint8Array): void {
    if (this.crcEnabled) {
      const c = sdCrc16(data);
      this.push((c >> 8) & 0xff, c & 0xff);
    } else {
      this.push(0xff, 0xff);
    }
  }

  /** R1 status byte - only the idle bit varies for our purposes. */
  private r1(): number {
    return this.idle ? 0x01 : 0x00;
  }

  private pushDataBlock(data: Uint8Array): void {
    this.push(0xfe); // start-block token
    for (let i = 0; i < data.length; i++) this.push(data[i]);
    this.pushDataCrc(data);
  }

  /** R1 + a short (16-byte) data block (CSD/CID). */
  private pushShort(payload: number[]): void {
    this.push(this.r1(), 0xfe, ...payload);
    this.pushDataCrc(Uint8Array.from(payload));
  }

  private buildCsd(): number[] {
    // prettier-ignore
    return [
      0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00,
      (this.cSize >> 16) & 0x3f, (this.cSize >> 8) & 0xff, this.cSize & 0xff,
      0x7f, 0x80, 0x0a, 0x40, 0x00, 0x01,
    ];
  }

  private buildCid(): number[] {
    // prettier-ignore
    return [0x01, 0x56, 0x58, 0x56, 0x45, 0x4c, 0x58, 0x53, // mfr, "VX", "VELXS"
            0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0x60, 0x01];
  }

  /**
   * SCR (SD Configuration Register) - the 8-byte block ACMD51 returns, MSB
   * first on the wire. IDF's `sdmmc_decode_scr` byte-swaps each word and reads
   * exactly three fields (driver/sdmmc_defs.h):
   *
   *   byte0 = SCR_STRUCTURE[63:60] | SD_SPEC[59:56]
   *         = 0x02 -> structure 0 (v1.0; ANY other value makes the IDF driver
   *           bail with ESP_ERR_NOT_SUPPORTED) and SD_SPEC 2 = SD 2.00, which
   *           matches the CSD v2 and the CMD8/R7 this card already answers.
   *   byte1 = DATA_STAT_AFTER_ERASE[55] | SD_SECURITY[54:52] | BUS_WIDTHS[51:48]
   *         = 0x35 -> security 3, bus widths 1-bit|4-bit (the standard value;
   *           in SPI mode the host stays 1-bit either way).
   *   bytes 2-7: reserved/SPEC3/EX_SECURITY - IDF reads none of them.
   *
   * NOTE this makes the card advertise SD_SPEC >= 1.10, which is the gate on
   * CMD6 SWITCH_FUNC (sdmmc_sd.c `sdmmc_enable_hs_mode`) - a command this model
   * does NOT implement. It is unreachable here: SDSPI_HOST_DEFAULT() sets
   * max_freq_khz = SDMMC_FREQ_DEFAULT, and `sdmmc_enable_hs_mode_and_check`
   * returns ESP_OK *before* touching CMD6 whenever host.max_freq_khz <=
   * SDMMC_FREQ_DEFAULT. A host that raises the clock past 20 MHz would need
   * CMD6 modelled here.
   */
  private buildScr(): number[] {
    return [0x02, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  }

  private processCmd(raw: number[]): void {
    const cmd = raw[0] & 0x3f;
    const arg = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
    const isAcmd = this.expectAcmd;
    this.expectAcmd = false;

    if (isAcmd) {
      if (cmd === 41) {
        // ACMD41 SD_SEND_OP_COND - report ready, leave idle state
        this.idle = false;
        this.push(0x00);
        return;
      }
      if (cmd === 13) {
        this.push(0x00, 0x00); // ACMD13 SD status (R2)
        return;
      }
      if (cmd === 51) {
        // ACMD51 SEND_SCR - R1 + an 8-byte data block, same shape as CSD/CID.
        // MANDATORY for the ESP-IDF stack: `sdmmc_card_init` runs
        // sdmmc_init_sd_scr for every SD memory card and reads the SCR a second
        // time in sdmmc_check_scr (a signal-integrity re-read, compared with
        // memcmp - this model is deterministic, so both agree). Answering R1
        // alone (the old `default:` path) left the host clocking 0xFF forever
        // waiting for a start token that never came. Arduino SD.h never issues
        // ACMD51, which is why the port shipped without it.
        this.pushShort(this.buildScr());
        return;
      }
      // fall through for other ACMDs
    }

    switch (cmd) {
      case 0: // GO_IDLE_STATE - (re)enter idle
        this.idle = true;
        this.push(0x01);
        break;
      case 8: // SEND_IF_COND - R7 = R1 + echo-back
        this.push(this.r1(), 0x00, 0x00, 0x01, 0xaa);
        break;
      case 9: // SEND_CSD
        this.pushShort(this.buildCsd());
        break;
      case 10: // SEND_CID
        this.pushShort(this.buildCid());
        break;
      case 12: // STOP_TRANSMISSION (ends CMD18)
        // Abort the in-flight CMD18 stream: full-duplex reply-first + the
        // continuous-read refill leaves the next block partially queued, so
        // clear it before the R1b or the host reads leftover data bytes ahead
        // of the stop response. Real cards stop streaming on CMD12; firmware
        // (SdFat) tolerates either, but flushing makes the R1b deterministic.
        this.multiRead = false;
        this.resp = [];
        this.respHead = 0;
        this.pushNcr(); // the flush dropped the Ncr dead byte - re-arm it
        this.push(0x00, 0x00, 0xff);
        break;
      case 13: // SEND_STATUS (R2)
        this.push(this.r1(), 0x00);
        break;
      case 16: // SET_BLOCKLEN (fixed 512)
        this.push(this.r1());
        break;
      case 17: // READ_SINGLE_BLOCK (byte addr)
        this.push(0x00);
        this.pushDataBlock(this.readBlock(arg >>> 9));
        break;
      case 18: // READ_MULTIPLE_BLOCK - stream until CMD12
        this.push(0x00);
        this.readAddr = arg >>> 9;
        this.multiRead = true;
        this.pushDataBlock(this.readBlock(this.readAddr));
        this.readAddr++;
        break;
      case 24: // WRITE_BLOCK - data block follows
        this.push(0x00);
        this.writeAddr = arg >>> 9;
        this.multiWrite = false;
        this.phase = 'wait-token';
        break;
      case 25: // WRITE_MULTIPLE_BLOCK - data blocks follow until stop token
        this.push(0x00);
        this.writeAddr = arg >>> 9;
        this.multiWrite = true;
        this.phase = 'wait-token';
        break;
      case 55: // APP_CMD prefix
        this.push(this.r1());
        this.expectAcmd = true;
        break;
      case 58: // READ_OCR - powered, CCS=0 (SDSC byte addressing)
        this.push(this.r1(), 0x80, 0xff, 0x80, 0x00);
        break;
      case 59: // CRC_ON_OFF - bit0 of arg toggles data-block CRC
        this.crcEnabled = (arg & 0x1) !== 0;
        this.push(this.r1());
        break;
      default:
        this.push(this.r1()); // accept unhandled commands
    }
  }

  // ── Per-byte full-duplex transfer ─────────────────────────────────────────

  /** Reply-first: return the MISO prepared by earlier bytes, then consume this
   *  MOSI byte (which queues MISO for subsequent transfers). While CS is
   *  deasserted the card ignores MOSI and MISO floats high (0xFF). */
  transfer(mosi: number): number {
    if (!this.cs) return 0xff;
    const reply = this.popResp();

    mosi &= 0xff;
    if (this.phase === 'cmd') {
      if (this.cmd.length === 0 && (mosi & 0xc0) === 0x40) {
        this.cmd = [mosi]; // command start (bit7=0, bit6=1)
      } else if (this.cmd.length > 0) {
        this.cmd.push(mosi);
        if (this.cmd.length === 6) {
          this.pushNcr();
          this.processCmd(this.cmd);
          this.cmd = [];
        }
      } else if (this.multiRead && this.respEmpty()) {
        // Continuous read: refill the next block while the host clocks 0xFF.
        this.pushDataBlock(this.readBlock(this.readAddr));
        this.readAddr++;
      }
    } else if (this.phase === 'wait-token') {
      if (mosi === 0xfe || mosi === 0xfc) {
        this.phase = 'recv-data';
        this.data = [];
      } else if (mosi === 0xfd) {
        // stop token (ends CMD25) - respond non-busy
        this.multiWrite = false;
        this.phase = 'cmd';
        this.push(0x00);
      }
      // else 0xFF gap - keep waiting
    } else if (this.phase === 'recv-data') {
      this.data.push(mosi);
      if (this.data.length === BLOCK) {
        this.phase = 'recv-crc';
        this.crcLeft = 2;
      }
    } else if (this.phase === 'recv-crc') {
      this.crcLeft--;
      if (this.crcLeft === 0) {
        this.writeBlock(this.writeAddr, this.data);
        this.writeAddr++;
        this.push(0x05); // data-response: accepted
        this.phase = this.multiWrite ? 'wait-token' : 'cmd';
      }
    }

    return reply;
  }
}

/**
 * The card as a device of the bus fabric.
 *
 * Chip select is the fabric's business: it only calls transfer() while the
 * card is selected, so the model's own gate just follows select/deselect. An
 * MCU reset is not a card reset - the image and everything the guest wrote to
 * it stay, exactly as they do on a board whose reset button never cuts the
 * card's power - so boardReset() only drops the transfer in flight.
 */
export function sdSpiFabricDevice(card: SdSpiCard): SpiDevice {
  return {
    select: () => card.setCs(true),
    deselect: () => card.setCs(false),
    transfer: (mosi: number) => card.transfer(mosi & 0xff),
    peekMiso: () => card.peekResponse(),
    boardReset: () => card.setCs(false),
  };
}

/** The portable model of this same card, under public/bus-chips. */
export const SD_BUS_CHIP = 'microsd';

/** Start the fetch of the portable model. Idempotent; call it on attach. */
export function loadSdBusChip(): void {
  void loadBusChip(SD_BUS_CHIP);
}

/**
 * The card as the artifact a remote host runs (project board-buses-2026-09,
 * F4). `minBytes` pads the image the same way {@link SdSpiCard.dumpImage}
 * does, so the model beside the guest sees the whole volume and not only the
 * sectors somebody touched.
 *
 * The image is the card's CURRENT contents rather than the one it was built
 * with: the worker sends back every span its model writes
 * ({@link sdCardRemoteBlobWrite}), so a map published after a write carries
 * what was written.
 *
 * Null while the artifact has not arrived, and null for a card with no image
 * at all: there is nothing for the model to serve, it would drive nothing, and
 * the bus says so once rather than shipping an entry the worker has to guess
 * at.
 */
/**
 * The half of the remote card that comes back: the worker sends the span its
 * model wrote (`bus_blob`) and this lands it on the tab's card, the one the
 * panel lists and the next map ships. Only the blob the model calls `card`.
 */
export function sdCardRemoteBlobWrite(card: SdSpiCard): (name: string, offset: number, data: Uint8Array) => void {
  return (name, offset, data) => {
    if (name === 'card') card.writeBytes(offset, data);
  };
}

export function sdCardRemoteModel(card: SdSpiCard, minBytes = 0): RemoteSpiModel | null {
  const wasmB64 = busChipB64(SD_BUS_CHIP);
  if (!wasmB64) return null;
  const image = card.dumpImage(minBytes);
  if (image.length === 0) return null;
  return { wasmB64, blobs: { card: bytesToBase64(image) } };
}
