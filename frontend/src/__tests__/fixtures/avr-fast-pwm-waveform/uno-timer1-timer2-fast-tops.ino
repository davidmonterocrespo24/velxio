// Timer2 in fast PWM with OCR2A as TOP (WGM 7) at prescaler 64: OCR2A = 99 is
// a 100-tick period (400 us), OCR2B = 24 on pin 3 is HIGH 25 ticks (100 us),
// and COM2A0 toggles pin 11 at TOP: a square wave of 800 us.
// Timer1 in 8-bit fast PWM (WGM 5) at prescaler 64: OCR1A = 64 on pin 9 is
// HIGH 65 ticks (260 us of 1024 us).
void setup() {
  pinMode(11, OUTPUT);
  pinMode(3, OUTPUT);
  OCR2A = 99;
  OCR2B = 24;
  TCCR2A = _BV(COM2A0) | _BV(COM2B1) | _BV(WGM21) | _BV(WGM20);
  TCCR2B = _BV(WGM22) | _BV(CS22);
  pinMode(9, OUTPUT);
  TCCR1A = 0;
  TCCR1B = 0;
  OCR1A = 64;
  TCCR1A = _BV(COM1A1) | _BV(WGM10);
  TCCR1B = _BV(WGM12) | _BV(CS11) | _BV(CS10);
}
void loop() {}
