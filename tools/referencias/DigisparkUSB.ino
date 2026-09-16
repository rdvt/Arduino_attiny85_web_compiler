#include <DigiUSB.h>

void setup() { DigiUSB.begin(); }

void loop() {
  if (DigiUSB.available()) { DigiUSB.write(DigiUSB.read()); }
  DigiUSB.refresh();
}
