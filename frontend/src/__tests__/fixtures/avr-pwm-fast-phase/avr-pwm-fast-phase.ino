// Timer0 fast PWM (pins 5, 6) against Timer1 phase-correct PWM (pin 9).
void setup() {
  analogWrite(6, 64);
  analogWrite(5, 1);
  analogWrite(9, 64);
  analogWrite(10, 1);
}
void loop() {}
