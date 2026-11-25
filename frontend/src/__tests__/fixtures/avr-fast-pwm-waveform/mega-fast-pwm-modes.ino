// ATmega2560, the other fast PWM modes of the 16-bit timers, prescaler 8
// (0.5 us ticks) unless noted:
// Timer4 with OCR4A as TOP (WGM 15): OCR4A = 1999 (1000 us); COM4A0 toggles
// pin 6 at TOP (a 2000 us square), OCR4B = 499 on pin 7 (250 us), OCR4C = 0 on
// pin 8 (a 0.5 us spike).
// Timer1 in 10-bit fast PWM (WGM 7): TOP 1023 (512 us); OCR1A = 511 on pin 11
// (256 us), OCR1B = 1023 = TOP on pin 12 (constantly HIGH).
// Timer5 in 9-bit fast PWM (WGM 6) at prescaler 64, inverting: TOP 511
// (2048 us); OCR5A = 99 on pin 46 is LOW 100 ticks, HIGH 1648 us.
void setup() {
  pinMode(6, OUTPUT);
  pinMode(7, OUTPUT);
  pinMode(8, OUTPUT);
  TCCR4A = 0;
  TCCR4B = 0;
  OCR4A = 1999;
  OCR4B = 499;
  OCR4C = 0;
  TCCR4A = _BV(COM4A0) | _BV(COM4B1) | _BV(COM4C1) | _BV(WGM41) | _BV(WGM40);
  TCCR4B = _BV(WGM43) | _BV(WGM42) | _BV(CS41);
  pinMode(11, OUTPUT);
  pinMode(12, OUTPUT);
  TCCR1A = 0;
  TCCR1B = 0;
  OCR1A = 511;
  OCR1B = 1023;
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM11) | _BV(WGM10);
  TCCR1B = _BV(WGM12) | _BV(CS11);
  pinMode(46, OUTPUT);
  TCCR5A = 0;
  TCCR5B = 0;
  OCR5A = 99;
  TCCR5A = _BV(COM5A1) | _BV(COM5A0) | _BV(WGM51);
  TCCR5B = _BV(WGM52) | _BV(CS51) | _BV(CS50);
}
void loop() {}
