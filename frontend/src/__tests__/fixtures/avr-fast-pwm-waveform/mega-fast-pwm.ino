// ATmega2560: Timer0's fast PWM pins through analogWrite (13: 260 us, 4: 8 us
// of 1024 us), and Timer3 and Timer5 in fast PWM with ICRn as TOP (WGM 14,
// prescaler 8, 1000 us) on every channel, C included: OC3A pin 5 (500 us),
// OC3B pin 2 (250 us), OC3C pin 3 (750 us), OC5C pin 44 (50 us).
void setup() {
  analogWrite(13, 64);
  analogWrite(4, 1);
  pinMode(5, OUTPUT);
  pinMode(2, OUTPUT);
  pinMode(3, OUTPUT);
  pinMode(44, OUTPUT);
  TCCR3A = 0;
  TCCR3B = 0;
  ICR3 = 1999;
  OCR3A = 999;
  OCR3B = 499;
  OCR3C = 1499;
  TCCR3A = _BV(COM3A1) | _BV(COM3B1) | _BV(COM3C1) | _BV(WGM31);
  TCCR3B = _BV(WGM33) | _BV(WGM32) | _BV(CS31);
  TCCR5A = 0;
  TCCR5B = 0;
  ICR5 = 1999;
  OCR5C = 99;
  TCCR5A = _BV(COM5C1) | _BV(WGM51);
  TCCR5B = _BV(WGM53) | _BV(WGM52) | _BV(CS51);
}
void loop() {}
