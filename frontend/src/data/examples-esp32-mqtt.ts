/**
 * ESP32 WiFi + MQTT gallery example.
 *
 * Proves the networking path end to end: the ESP32 joins the emulator's
 * virtual AP (SSID "Velxio-GUEST"), reaches the internet via QEMU slirp NAT,
 * and round-trips MQTT messages through a public broker (broker.hivemq.com).
 *
 * Self-contained: the sketch publishes to a unique topic AND subscribes to
 * the same topic, so each message comes back through the broker (toggling
 * GPIO2). No external client or local broker needed — just open the Serial
 * Monitor at 115200 and watch TX/RX. Verified in QEMU: WiFi connects, DNS
 * resolves, TCP to :1883 succeeds.
 */
import type { ExampleProject } from './examples';

const ESP32_MQTT_CODE = `// ESP32 + WiFi + MQTT (PubSubClient)
// Joins the emulator AP "Velxio-GUEST", connects to a public MQTT broker,
// then publishes to its own topic and subscribes to it, so every message
// round-trips through the broker and toggles GPIO2. Open the Serial Monitor
// at 115200. Wire an LED to GPIO2 to watch it blink on each round-trip.
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "Velxio-GUEST";  // open AP the emulator advertises
const char* MQTT_BROKER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const int LED = 2;

WiFiClient net;
PubSubClient mqtt(net);
String topic;  // unique per board so two ESP32s don't collide

void onMessage(char* t, byte* payload, unsigned int len) {
  String m;
  for (unsigned int i = 0; i < len; i++) m += (char)payload[i];
  Serial.printf("RX [%s]: %s\\n", t, m.c_str());
  digitalWrite(LED, !digitalRead(LED));  // toggle on every round-trip
}

void connectWiFi() {
  Serial.printf("WiFi: joining %s ...\\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.printf("\\nWiFi connected, IP %s\\n", WiFi.localIP().toString().c_str());
}

void connectMQTT() {
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(onMessage);
  while (!mqtt.connected()) {
    String cid = "velxio-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    Serial.printf("MQTT: connecting to %s as %s ...\\n", MQTT_BROKER, cid.c_str());
    if (mqtt.connect(cid.c_str())) {
      Serial.println("MQTT connected");
      mqtt.subscribe(topic.c_str());
      Serial.printf("Subscribed to %s\\n", topic.c_str());
    } else {
      Serial.printf("MQTT failed, rc=%d, retry in 2s\\n", mqtt.state());
      delay(2000);
    }
  }
}

unsigned long lastPub = 0;
int counter = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  delay(500);
  topic = "velxio/demo/" + String((uint32_t)ESP.getEfuseMac(), HEX);
  connectWiFi();
  connectMQTT();
}

void loop() {
  if (!mqtt.connected()) connectMQTT();
  mqtt.loop();
  if (millis() - lastPub > 2000) {
    lastPub = millis();
    String msg = "hello " + String(counter++);
    mqtt.publish(topic.c_str(), msg.c_str());
    Serial.printf("TX [%s]: %s\\n", topic.c_str(), msg.c_str());
  }
}
`;

export const esp32MqttExamples: ExampleProject[] = [
  {
    id: 'esp32-wifi-mqtt',
    title: 'ESP32 WiFi + MQTT',
    description:
      'Connect an ESP32 to WiFi and a public MQTT broker. The sketch publishes ' +
      "to its own topic and subscribes to it, so every message round-trips through " +
      'broker.hivemq.com and toggles GPIO2 — a self-contained test of WiFi and MQTT ' +
      'with no external setup. Open the Serial Monitor at 115200 to watch it connect ' +
      'and exchange messages. The emulator advertises an open AP named "Velxio-GUEST".',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'esp32',
    boardFilter: 'esp32',
    tags: ['esp32', 'wifi', 'mqtt', 'pubsubclient', 'iot', 'network'],
    libraries: ['PubSubClient'],
    code: ESP32_MQTT_CODE,
    components: [],
    wires: [],
  },
];
