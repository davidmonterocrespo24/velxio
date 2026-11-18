/**
 * ESP32 WiFi + MQTT gallery example.
 *
 * Proves the networking path end to end: the ESP32 joins the emulator's
 * virtual AP (SSID "Velxio-GUEST"), reaches the internet via QEMU slirp NAT,
 * and round-trips MQTT messages through a public broker (broker.hivemq.com).
 *
 * Self-contained: the sketch publishes to a topic of its own AND subscribes to
 * the same topic, so each message comes back through the broker (toggling the
 * DevKit's own LED on GPIO2). No external client or local broker needed — just
 * open the Serial Monitor at 115200 and watch TX/RX. Verified in QEMU: WiFi
 * connects, DNS resolves, TCP to :1883 succeeds.
 *
 * The topic and the client id must differ between the people running it at
 * the same time: the broker is shared, and it drops a client when another
 * connects with its id (MQTT 3.1.1, MQTT-3.1.4-2). They used to come from
 * ESP.getEfuseMac(), and every emulated ESP32 has the same factory MAC, so
 * everyone shared velxio/demo/c40a24 and kicked each other off in a loop
 * (velxio/velxio-prod#184). A value baked in at compile time would not do
 * either: the build cache hands the same gallery binary to everyone.
 */
import type { ExampleProject } from './examples';

const ESP32_MQTT_CODE = `// ESP32 + WiFi + MQTT (PubSubClient)
// Joins the emulator AP "Velxio-GUEST", connects to a public MQTT broker,
// then publishes to its own topic and subscribes to it, so every message
// round-trips through the broker and toggles the DevKit's own LED (GPIO2).
// Open the Serial Monitor at 115200.
//
// Everyone who runs this example shares broker.hivemq.com, and the broker
// drops a client when another one connects with the same id. Every emulated
// ESP32 has the same factory MAC, so the id and the topic cannot come from
// the chip alone: makeId() mixes in the hardware random number generator and
// the clock read after a round trip to the network, which differ every run.
// Put a name of your own in MY_ID to choose them yourself.
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "Velxio-GUEST";  // open AP the emulator advertises
const char* MQTT_BROKER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const int LED = 2;            // the DevKit's own blue LED
const char* MY_ID = "";       // e.g. "ana-lab3"; empty: a new one every run

WiFiClient net;
PubSubClient mqtt(net);
String id;     // this board's name on the broker
String topic;  // velxio/demo/<id>

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

String makeId() {
  if (strlen(MY_ID) > 0) return String(MY_ID);
  // The MAC tells real boards apart. The emulated ones all share it, so mix
  // in the hardware RNG and the clock read after the broker's name is looked
  // up: a network round trip takes a different time on every run.
  IPAddress broker;
  WiFi.hostByName(MQTT_BROKER, broker);
  uint32_t mix = (uint32_t)ESP.getEfuseMac() ^ (uint32_t)random(0x7FFFFFFF)
                 ^ (micros() * 2654435761u);
  return String(mix, HEX);
}

void connectMQTT() {
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(onMessage);
  while (!mqtt.connected()) {
    String cid = "velxio-" + id;
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
  connectWiFi();
  id = makeId();
  topic = "velxio/demo/" + id;
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
      "broker.hivemq.com and toggles the board's own LED on GPIO2 — a self-contained " +
      'test of WiFi and MQTT with no external setup. Each run gets its own topic and ' +
      'client id (set MY_ID to choose them), so people running it at the same time ' +
      'do not knock each other off the broker. Open the Serial Monitor at 115200 to ' +
      'watch it connect and exchange messages. The emulator advertises an open AP ' +
      'named "Velxio-GUEST".',
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
