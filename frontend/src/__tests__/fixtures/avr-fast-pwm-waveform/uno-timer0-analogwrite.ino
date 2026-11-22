// Timer0 fast PWM through the Arduino core (WGM 3, TOP 0xFF, prescaler 64:
// 4 us ticks, 1024 us period). The chip holds pin 6 HIGH for 65 ticks (260 us)
// and pin 5 for 2 (8 us). The sketch measures its own pins with pulseIn,
// interrupts off: the HIGH starts at Timer0's overflow, where millis()'s ISR
// would otherwise eat the first microseconds of the count.
void setup() {
  Serial.begin(115200);
  analogWrite(6, 64);
  analogWrite(5, 1);
}
void loop() {
  static uint8_t n = 0;
  if (n < 3) {
    n++;
    noInterrupts();
    unsigned long high6 = pulseIn(6, HIGH);
    unsigned long low6 = pulseIn(6, LOW);
    unsigned long high5 = pulseIn(5, HIGH);
    interrupts();
    Serial.print(high6);
    Serial.print(' ');
    Serial.print(low6);
    Serial.print(' ');
    Serial.println(high5);
  }
}
