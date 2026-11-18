/**
 * The gallery's MQTT example gives each run its own client ID and topic
 * (velxio/velxio-prod#185).
 *
 * It built both from the factory MAC, and every simulated ESP32 has the same
 * one (24:0a:c4:00:01:10, #187): every user connected to broker.hivemq.com as
 * velxio-c40a24 and published on velxio/demo/c40a24. An MQTT broker drops the
 * session already holding a client ID when another connects with it ([MQTT-3.1.4-2]),
 * and every user's messages toggled every other user's LED. The ID now comes
 * from esp_random(), which the engines seed per boot.
 */
import { describe, expect, it } from 'vitest';
import { esp32MqttExamples } from '../data/examples-esp32-mqtt';

describe('the gallery MQTT example (velxio/velxio-prod#185)', () => {
  const code = esp32MqttExamples.find((e) => e.id === 'esp32-wifi-mqtt')!.code;

  it('does not name its client or its topic after the MAC, which every simulated board shares', () => {
    expect(code).not.toMatch(/getEfuseMac|macAddress/);
  });

  it('draws one random word at boot for both', () => {
    expect(code).toMatch(/id = String\(esp_random\(\), HEX\);/);
    expect(code).toMatch(/String cid = "velxio-" \+ id;/);
    expect(code).toMatch(/topic = "velxio\/demo\/" \+ id;/);
  });
});
