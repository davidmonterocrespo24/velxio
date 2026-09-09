/**
 * DHT22 (AM2302) — single-wire, bidirectional, self-timed.
 *
 *  1. MCU holds DATA LOW for >= 1 ms (start signal)
 *  2. MCU RELEASES DATA (a direction change; the pull-up raises the line)
 *  3. Sensor: 80 us LOW, 80 us HIGH (response preamble)
 *  4. 40 bits MSB first, each 50 us LOW + (26 us HIGH = '0' | 70 us HIGH = '1')
 *  5. 50 us LOW, then the sensor releases the line
 *
 * Payload: [hum_H, hum_L, temp_H, temp_L, checksum], humidity in 0.1 %RH,
 * temperature in 0.1 C with the sign in bit 15.
 *
 * The frame has 84 edges, so the timeline treats it as self-timed and holds
 * the board's clock catch-up for its ~5 ms: Adafruit's DHT.h measures each
 * pulse by counting digitalRead() iterations, and a clock skip between two
 * edges collapses every count to the same value.
 */

import { assertedLow, releasedLow } from '../padEvent';
import type { HostEdge, HostEdgeFrame } from '../LineTimeline';
import { numberField, registerLineModel, type LineClock, type LineModel } from '../lineModels';

/**
 * How long after the master releases the line the sensor starts answering.
 *
 * The AM2302 datasheet gives this as 20-40 us and the model used to take the
 * bottom of that range, which is the worst end for an EMULATED master. The
 * driver's whole read hinges on arriving inside the 80 us response LOW, and
 * what it spends getting there is not the wire's problem but the guest's:
 * arduino-esp32's `pinMode` costs 6 us of guest time on a classic ESP32 and
 * 58 us on an ESP32-P4, nearly all of it inside the peripheral manager
 * (`perimanGetPinBus`, ~11 000 instructions a call). Adafruit's DHT.h then
 * waits its own `pullTime` of 55 us on top before it first looks. At 20 us the
 * P4 arrives about 10 us before the LOW ends and its first `expectPulse(LOW)`
 * returns instantly, which puts every one of the 80 pulses that follow one
 * phase out and ends the read in 80 timeouts and a NaN.
 *
 * 40 us is the other end of the same datasheet range, so this is not a widened
 * window -- it is the same sensor, specified. It strictly helps every host: a
 * master that arrives EARLY finds more of the LOW left than before, and one
 * that arrives late finds some at all.
 *
 * Measured on the P4 with a sketch timing the pad itself: the response the
 * guest sees goes from `low starts +5 us, lasts 67 us` to `+11 us, lasts
 * 80 us` -- the full width the datasheet specifies, where before the guest
 * was arriving too late to see a sixth of it. On a classic ESP32, where the
 * read already worked, it keeps working (28.0 C / 65.0 % on the gallery
 * example, unchanged).
 *
 * It does NOT make Adafruit's DHT.h read on the P4: that still returns NaN,
 * and the reason is somewhere past the preamble, not in this constant.
 */
export const DHT22_RESPONSE_START_US = 40;

export const DHT22_DEFAULT_TEMPERATURE_C = 25.0;
export const DHT22_DEFAULT_HUMIDITY_PCT = 50.0;

/** The 5-byte payload, byte-for-byte what a real AM2302 sends. */
export function dht22Payload(temperatureC: number, humidityPct: number): Uint8Array {
  const humidity = Math.round(humidityPct * 10);
  const temperature = Math.round(temperatureC * 10);
  const h_H = (humidity >> 8) & 0xff;
  const h_L = humidity & 0xff;
  const rawTemp = temperature < 0 ? (-temperature & 0x7fff) | 0x8000 : temperature & 0x7fff;
  const t_H = (rawTemp >> 8) & 0xff;
  const t_L = rawTemp & 0xff;
  const chk = (h_H + h_L + t_H + t_L) & 0xff;
  return new Uint8Array([h_H, h_L, t_H, t_L, chk]);
}

/**
 * The response waveform on DATA, starting {@link DHT22_RESPONSE_START_US} after the
 * MCU's release.
 */
export function dht22Frame(
  pin: number,
  releaseCycle: number,
  payload: Uint8Array,
  us: (n: number) => number,
): HostEdgeFrame {
  const RESPONSE_START = us(DHT22_RESPONSE_START_US);
  const LOW80 = us(80);
  const HIGH80 = us(80);
  const LOW50 = us(50);
  const HIGH0 = us(26);
  const HIGH1 = us(70);

  const edges: HostEdge[] = [];
  let t = releaseCycle + RESPONSE_START;
  edges.push({ level: false, atCycle: t });
  t += LOW80;
  edges.push({ level: true, atCycle: t });
  t += HIGH80;
  for (const byte of payload) {
    for (let b = 7; b >= 0; b--) {
      const bit = (byte >> b) & 1;
      edges.push({ level: false, atCycle: t });
      t += LOW50;
      edges.push({ level: true, atCycle: t });
      t += bit ? HIGH1 : HIGH0;
    }
  }
  edges.push({ level: false, atCycle: t });
  t += LOW50;
  edges.push({ level: true, atCycle: t });
  // The sensor lets go right after its final HIGH: a small margin so the last
  // edge is applied before the pad returns to the guest.
  return { pin, edges, releaseAtCycle: t + us(50) };
}

registerLineModel('dht22', (rec) => {
  const pin = rec.pin;
  let temperatureC = numberField(rec.temperature, DHT22_DEFAULT_TEMPERATURE_C);
  let humidityPct = numberField(rec.humidity, DHT22_DEFAULT_HUMIDITY_PCT);
  let wasLow = false;
  /** While the sensor talks it does not listen: real hardware ignores the master until its frame is out. */
  let busyUntil = -Infinity;

  const model: LineModel = {
    listens: [pin],
    drives: [pin],
    rest: () => [{ pin, level: true, driven: false }],
    onPad(e, clock: LineClock) {
      const now = clock.now();
      if (now < busyUntil) return null;
      if (assertedLow(e)) {
        wasLow = true;
        return null;
      }
      if (!releasedLow(e) || !wasLow) return null;
      wasLow = false;
      const frame = dht22Frame(pin, now, dht22Payload(temperatureC, humidityPct), clock.us);
      busyUntil = frame.releaseAtCycle ?? frame.edges[frame.edges.length - 1].atCycle;
      return frame;
    },
    update(props) {
      if ('temperature' in props) temperatureC = numberField(props.temperature, temperatureC);
      if ('humidity' in props) humidityPct = numberField(props.humidity, humidityPct);
    },
    reset() {
      wasLow = false;
      busyUntil = -Infinity;
    },
  };
  return model;
});
