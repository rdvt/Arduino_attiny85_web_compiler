#include <DigiCDC.h>

void setup() { SerialUSB.begin(); }

void loop() {
  if (SerialUSB.available()) {
    SerialUSB.write(SerialUSB.read());
  }
  SerialUSB.delay(10);
}
