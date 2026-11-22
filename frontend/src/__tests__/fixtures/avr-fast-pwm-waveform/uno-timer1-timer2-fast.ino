// Timer2 in fast PWM (WGM 3, TOP 0xFF) at prescaler 64: OCR2A = 64 on pin 11
// (260 us of 1024 us), OCR2B = 0 on pin 3 (a 4 us spike).
// Timer1 in fast PWM with ICR1 as TOP (WGM 14) at prescaler 8 (0.5 us ticks):
// ICR1 = 1999 (1000 us), OCR1A = 999 on pin 9 (500 us), OCR1B = 0 on pin 10
// (a 0.5 us spike).
void setup() {
  pinMode(11, OUTPUT);
  pinMode(3, OUTPUT);
  OCR2A = 64;
  OCR2B = 0;
  TCCR2A = _BV(COM2A1) | _BV(COM2B1) | _BV(WGM21) | _BV(WGM20);
  TCCR2B = _BV(CS22);
  pinMode(9, OUTPUT);
  pinMode(10, OUTPUT);
  TCCR1A = 0;
  TCCR1B = 0;
  ICR1 = 1999;
  OCR1A = 999;
  OCR1B = 0;
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM11);
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS11);
}
void loop() {}
