// Gallery example l293d-speed-pwm, verbatim (no Serial.begin), pot replaced by a constant read path.
#define EN 9
#define IN1 7
#define IN2 8
void setup() {
  pinMode(EN, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
}
void loop() {
  int pot = analogRead(A0);
  int speed = map(pot, 0, 1023, 0, 255);
  analogWrite(EN, speed);
  Serial.print("Speed: ");
  Serial.println(speed);
  delay(100);
}
