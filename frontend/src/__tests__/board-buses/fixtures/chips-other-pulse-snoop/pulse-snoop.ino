// A chip (the gallery pulse counter, threshold 4) listens on D2; its OVF output
// comes back on D4.
// Phase 1: the MCU drives D2 itself, 4 pulses, and reports OVF ("mcu ovf=").
// Phase 2: D2 becomes an input driven by another part on the canvas. The sketch
// counts the rising edges it sees ("rise N") and reports OVF on every change.
void setup() {
  Serial.begin(115200);
  pinMode(4, INPUT);
  pinMode(2, OUTPUT);
  digitalWrite(2, LOW);
  Serial.print("READY\n");
  for (int i = 0; i < 4; i++) {
    digitalWrite(2, HIGH);
    delay(1);
    digitalWrite(2, LOW);
    delay(1);
  }
  Serial.print("mcu ovf=");
  Serial.print(digitalRead(4));
  Serial.print("\n");
  pinMode(2, INPUT);
  Serial.print("phase2\n");
}

int last = -1;
unsigned int rises = 0;
int lastOvf = -1;

void loop() {
  int v = digitalRead(2);
  if (last == 0 && v == 1) {
    rises++;
    Serial.print("rise ");
    Serial.print(rises);
    Serial.print("\n");
  }
  last = v;
  int o = digitalRead(4);
  if (o != lastOvf) {
    Serial.print("ovf=");
    Serial.print(o);
    Serial.print("\n");
    lastOvf = o;
  }
}
