/**
 * The gallery's MQTT example gives each run its own client ID and topic
 * (velxio/velxio-prod#185).
 *
 * It built both from the factory MAC, and every simulated ESP32 has the same
 * one (24:0a:c4:00:01:10, #187): every user connected to broker.hivemq.com as
 * velxio-c40a24 and published on velxio/demo/c40a24. An MQTT broker drops the
 * session already holding a client ID when another connects with it ([MQTT-3.1.4-2]),
 * and every user's messages toggled every other user's LED. The ID now draws
 * on the hardware random number generator, which the engines seed per boot:
 * Arduino-ESP32's random() reads esp_random(). The example is #184's
 * (esp32-mqtt-example-per-run-id.test.ts), which also mixes in the clock after
 * a network round trip, so it differs per run on engines that do not seed yet.
 */
import { describe, expect, it } from 'vitest';
import { esp32MqttExamples } from '../data/examples-esp32-mqtt';

describe('the gallery MQTT example (velxio/velxio-prod#185)', () => {
  const code = esp32MqttExamples.find((e) => e.id === 'esp32-wifi-mqtt')!.code;

  it('does not name its client or its topic after the MAC, which every simulated board shares', () => {
    expect(code).not.toMatch(/"velxio-"\s*\+\s*String\(\(uint32_t\)ESP\.getEfuseMac\(\)/);
    expect(code).not.toMatch(/"velxio\/demo\/"\s*\+\s*String\(\(uint32_t\)ESP\.getEfuseMac\(\)/);
    expect(code).not.toMatch(/macAddress/);
  });

  it('draws one id at boot from the hardware random number generator, for both', () => {
    const makeId = code.slice(code.indexOf('String makeId()'), code.indexOf('void connectMQTT()'));
    expect(makeId).toMatch(/\brandom\(|\besp_random\(/);
    expect(code).toMatch(/id = makeId\(\);/);
    expect(code).toMatch(/String cid = "velxio-" \+ id;/);
    expect(code).toMatch(/topic = "velxio\/demo\/" \+ id;/);
  });
});
