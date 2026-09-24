/**
 * One board's remote SPI lane (project board-buses-2026-09, F4).
 *
 * It owns the two halves a QEMU board needs and nothing else does: the
 * controller port the worker's bytes arrive on, and the bus map that tells the
 * worker who is on the bus and how each one is selected.
 *
 * The port is created ONCE per board and kept: a device is on this board's bus
 * because its pins are on the controller's nets, and that must survive every
 * rebuild of the bridge behind it (D-003). The map is pushed again whenever
 * membership changes, because that is the only moment the worker's answer can
 * become wrong.
 */

import { arduinoSpiController } from './pinFunctions';
import { busRegistry, type RemoteSpiMapEntry } from './registry';
import { RemoteSpiPort } from './remotePort';
import type { BoardPins, EngineBinding } from './types';

export class RemoteSpiLane {
  /** null for a board whose pin table names no SPI controller at all. */
  readonly port: RemoteSpiPort | null;

  private readonly boardId: string;
  private readonly send: (spi: RemoteSpiMapEntry[]) => void;
  private readonly sendAttrs: ((owner: string, attrs: Record<string, number>) => void) | null;

  /**
   * `sendAttrs` carries a device's live inputs between maps (`bus_attrs`): the
   * map says who is on the bus and ships each model once, this says what the
   * finger, the slider or the circuit solve changed since, in a few bytes.
   */
  constructor(
    boardId: string,
    boardKind: string,
    send: (spi: RemoteSpiMapEntry[]) => void,
    sendAttrs?: (owner: string, attrs: Record<string, number>) => void,
  ) {
    this.boardId = boardId;
    this.send = send;
    this.sendAttrs = sendAttrs ?? null;
    const def = arduinoSpiController(boardKind);
    this.port = def ? new RemoteSpiPort({ unit: def.unit, name: def.name }) : null;
  }

  /** The binding the fabric gets for this board: its pins and the one port. */
  binding(pins: BoardPins): EngineBinding {
    return { pins, spi: this.port ? [this.port] : [] };
  }

  /**
   * Send the map now. The store calls this for the board whose membership the
   * registry says changed; the lane does not subscribe itself, because a shim
   * is rebuilt whenever the bridge behind it is and a per-lane subscription
   * would outlive every one of them.
   */
  pushMap(): void {
    try {
      this.send(busRegistry.remoteSpiMap(this.boardId));
    } catch (e) {
      console.warn(`[RemoteSpiLane:${this.boardId}] the bus map could not be sent`, e);
    }
  }

  /**
   * One device's live inputs changed. Routed like the map, by the store, for
   * the same reason: a lane does not subscribe itself.
   */
  pushAttrs(owner: string, attrs: Record<string, number>): void {
    try {
      this.sendAttrs?.(owner, attrs);
    } catch (e) {
      console.warn(`[RemoteSpiLane:${this.boardId}] live inputs of ${owner} could not be sent`, e);
    }
  }
}
