// RC Charging — observe exponential curve
// tau = R*C = 10k * 100uF = 1 second
void setup() {
  Serial.begin(9600);
  pinMode(8, OUTPUT);
  digitalWrite(8, HIGH);  // start charging
}
void loop() {
  float v = analogRead(A0) * 5.0 / 1023.0;
  Serial.print("V_cap = ");
  Serial.println(v, 3);
  delay(100);
}
