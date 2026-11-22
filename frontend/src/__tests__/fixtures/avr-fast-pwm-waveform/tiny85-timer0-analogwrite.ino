// ATtiny85 (ATTinyCore, 16 MHz PLL): its core runs Timer0 in fast PWM (WGM 3)
// at prescaler 64, like the Uno's: PB0 HIGH 65 ticks (260 us), PB1 2 (8 us).
void setup() {
  analogWrite(0, 64);
  analogWrite(1, 1);
}
void loop() {}
