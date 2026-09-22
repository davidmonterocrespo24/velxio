// A request/response UART sketch (the MH-Z16 / Grove UART shape).
// D2 LOW at boot: send the request byte 'G' once. D2 HIGH: only listen.
// 300 ms after boot, report how many bytes came back and the first one.
unsigned long t0;
unsigned int count = 0;
int first = -1;
bool reported = false;

void setup() {
  Serial.begin(9600);
  pinMode(2, INPUT);
  Serial.print("ready\n");
  if (digitalRead(2) == LOW) Serial.write('G');
  t0 = millis();
}

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    if (first < 0) first = c;
    count++;
  }
  if (!reported && millis() - t0 >= 300) {
    reported = true;
    Serial.print("n=");
    Serial.print(count);
    Serial.print(" f=");
    Serial.print(first);
    Serial.print("\n");
  }
}
