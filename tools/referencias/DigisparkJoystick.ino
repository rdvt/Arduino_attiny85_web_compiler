#include <DigiJoystick.h>

void setup() {}

void loop() {
  DigiJoystick.setX((byte)(millis() / 100));
  DigiJoystick.setY((byte)0x30);
  DigiJoystick.setXROT((byte)0x60);
  DigiJoystick.setYROT((byte)0x90);
  DigiJoystick.setZROT((byte)0xB0);
  DigiJoystick.setSLIDER((byte)0xF0);
  DigiJoystick.delay(50);
}
