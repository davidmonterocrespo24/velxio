/**
 * The gallery's MQTT example gives every run its own topic and client id
 * (velxio/velxio-prod#184).
 *
 * broker.hivemq.com is shared by everyone who runs the example, and an MQTT
 * broker drops a client when another one connects with the same client id
 * (MQTT 3.1.1, MQTT-3.1.4-2); the sketch reconnects from loop(), so two
 * people kick each other off in a loop. The id and the topic came from
 * ESP.getEfuseMac(), and every emulated ESP32, in the browser engines and in
 * QEMU, has the same factory MAC: everyone shared velxio/demo/c40a24, saw each
 * other's messages and fought over velxio-c40a24. A value baked in at compile
 * time would not do either, since the build cache hands one gallery binary to
 * everyone: the sketch must make the id up when it runs.
 */
import { describe, expect, it } from 'vitest';
import { esp32MqttExamples } from '../data/examples-esp32-mqtt';

const example = esp32MqttExamples.find((e) => e.id === 'esp32-wifi-mqtt')!;
const code = example.code;

describe('esp32-wifi-mqtt: one topic and one client id per run', () => {
  it('neither the topic nor the client id is the MAC alone', () => {
    expect(code).not.toMatch(/topic\s*=\s*"velxio\/demo\/"\s*\+\s*String\(\(uint32_t\)ESP\.getEfuseMac\(\)/);
    expect(code).not.toMatch(/"velxio-"\s*\+\s*String\(\(uint32_t\)ESP\.getEfuseMac\(\)/);
    expect(code).toMatch(/topic\s*=\s*"velxio\/demo\/"\s*\+\s*id\s*;/);
    expect(code).toMatch(/String cid\s*=\s*"velxio-"\s*\+\s*id\s*;/);
  });

  it('the id mixes in what differs between runs, at run time', () => {
    const makeId = code.slice(code.indexOf('String makeId()'), code.indexOf('void connectMQTT()'));
    expect(makeId).toContain('random(');
    expect(makeId).toContain('micros()');
    // ...measured after a round trip to the network, after WiFi is up.
    expect(makeId).toContain('WiFi.hostByName(');
    const setup = code.slice(code.indexOf('void setup()'));
    expect(setup.indexOf('connectWiFi();')).toBeLessThan(setup.indexOf('id = makeId();'));
    expect(setup.indexOf('id = makeId();')).toBeLessThan(setup.indexOf('connectMQTT();'));
  });

  it('a name of the reader\'s own can replace it', () => {
    expect(code).toMatch(/const char\* MY_ID = "";/);
    expect(code).toMatch(/if \(strlen\(MY_ID\) > 0\) return String\(MY_ID\);/);
  });

  it('says nothing that is not so: no "unique per board", no LED to wire', () => {
    expect(code).not.toMatch(/unique per board/i);
    expect(code).not.toMatch(/Wire an LED/i);
    // The DevKit's own LED on GPIO2 is drawn on the board and lights.
    expect(code).toMatch(/const int LED = 2;/);
    expect(example.description).toContain("board's own LED on GPIO2");
  });
});
