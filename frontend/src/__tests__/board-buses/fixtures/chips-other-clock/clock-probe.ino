// D3 -> chip IN: a 20 ms square wave (10 ms high, 10 ms low) timed on micros().
// D2 <- chip OUT: the period of the chip's timer output, measured in guest time.
unsigned long lastToggle = 0;
bool level = false;
int lastIn = -1;
unsigned long lastRise = 0;
int periods = 0;

void setup() {
  Serial.begin(115200);
  pinMode(3, OUTPUT);
  pinMode(2, INPUT);
  Serial.print("READY\n");
  lastToggle = micros();
}

void loop() {
  unsigned long now = micros();
  if (now - lastToggle >= 10000UL) {
    lastToggle += 10000UL;
    level = !level;
    digitalWrite(3, level);
  }
  int in = digitalRead(2);
  if (lastIn == 0 && in == 1) {
    if (lastRise != 0 && periods < 8) {
      Serial.print("P=");
      Serial.print(now - lastRise);
      Serial.print("\n");
      periods++;
    }
    lastRise = now;
  }
  lastIn = in;
}
