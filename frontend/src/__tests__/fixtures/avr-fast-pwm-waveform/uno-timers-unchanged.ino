// What leans on avr8js's own timer state: millis() (Timer0's overflow), tone()
// (Timer2 in CTC) and the phase-correct analogWrite pins (Timer1).
// Pin 12 toggles every 100 ms of millis(); tone(8, 1000) is a 1 kHz square;
// analogWrite(9, 64) and analogWrite(10, 1) are 64/255 and 1/255 of 2040 us.
void setup() {
  pinMode(12, OUTPUT);
  analogWrite(9, 64);
  analogWrite(10, 1);
  tone(8, 1000);
}
void loop() {
  static unsigned long last = 0;
  if (millis() - last >= 100) {
    last += 100;
    digitalWrite(12, !digitalRead(12));
  }
}
