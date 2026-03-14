// ESP32 QEMU-compatible blink test
// Uses short delays and prints before delay to avoid FreeRTOS cache issue.

#define LED_PIN 2

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 Blink Test Started");
  pinMode(LED_PIN, OUTPUT);

  // Print LED ON/OFF in setup before any vTaskDelay is needed
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    Serial.println("LED ON");
    Serial.flush();
    ets_delay_us(200000);  // 200ms ROM busy-wait (no FreeRTOS, no cache issue)

    digitalWrite(LED_PIN, LOW);
    Serial.println("LED OFF");
    Serial.flush();
    ets_delay_us(200000);
  }

  Serial.println("BLINK_DONE");
  Serial.flush();
}

void loop() {
  // Nothing - all work done in setup to avoid FreeRTOS cache crash in QEMU
  ets_delay_us(1000000);
}
