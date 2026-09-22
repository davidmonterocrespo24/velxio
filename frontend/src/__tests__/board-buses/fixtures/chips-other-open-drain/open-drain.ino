// An open-drain IRQ on D2 (INPUT_PULLUP, FALLING interrupt), asserted by a
// chip while D3 (TRIG) is high and released when D3 goes low.
volatile unsigned int irqs = 0;
void onIrq() { irqs++; }

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  pinMode(3, OUTPUT);
  digitalWrite(3, LOW);
  attachInterrupt(digitalPinToInterrupt(2), onIrq, FALLING);
  Serial.print("READY\n");
  delay(2);
  for (int i = 0; i < 5; i++) {
    digitalWrite(3, HIGH);
    delay(2);
    int held = digitalRead(2);
    digitalWrite(3, LOW);
    delay(2);
    int rel = digitalRead(2);
    Serial.print("held=");
    Serial.print(held);
    Serial.print(" rel=");
    Serial.print(rel);
    Serial.print("\n");
  }
  Serial.print("irqs=");
  Serial.print(irqs);
  Serial.print("\n");
}

void loop() {}
