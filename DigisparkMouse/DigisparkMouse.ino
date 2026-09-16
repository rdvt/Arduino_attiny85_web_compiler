/* ============================================================================
 *  Digispark (ATtiny85) como MOUSE USB
 *  Librería: DigiMouse  (viene con las Digistump AVR Boards)
 *
 *  Qué hace: al conectarlo al PC se identifica como un mouse y mueve el
 *  cursor solo, en forma de cuadro, y vuelve al punto de partida (no te
 *  "roba" el cursor). Sirve como mouse jiggler / para probar HID.
 *
 *  Placa en el IDE:  Tools > Board > Digispark (Default - 16.5 MHz)
 *  Subida:           clic en Upload y ENCHUFA el Digispark cuando el IDE
 *                    lo pida (micronucleus tiene ~5 s de ventana).
 *
 *  ---------------------------------------------------------------------------
 *  REGLAS OBLIGATORIAS de DigiMouse (si no, el USB se cae o el cursor no se mueve)
 *  ---------------------------------------------------------------------------
 *  1) Usa SIEMPRE DigiMouse.delay(...) en lugar de delay(...).
 *     DigiMouse.delay() llama a usbPoll() por dentro; delay() normal NO, y el
 *     host corta la comunicación.
 *  2) moveX()/moveY()/move() SOLO guardan el delta en un buffer. El reporte
 *     se envía cuando hay un DigiMouse.delay() (o un DigiMouse.update()).
 *  3) El intervalo mínimo de reporte es ~20 ms. Si llamas a move() más rápido
 *     que eso, el siguiente move() SOBRESCRIBE el anterior y pierdes movimiento.
 *     Por eso INTERVALO_MS nunca debe ser menor a 20.
 *  4) Los deltas son 'char' con signo: rango -127..127 por paso.
 *  5) No puedes incluir DigiMouse.h y DigiKeyboard.h en el mismo sketch
 *     (ambas definen el descriptor USB -> error de símbolos duplicados).
 *     Elige uno: o es mouse, o es teclado.
 *  6) Ojo con leftClick()/rightClick()/middleClick(): en la librería oficial
 *     las tres están mal implementadas (todas ponen el bit del botón derecho).
 *     Usa DigiMouse.setButtons() con las máscaras de abajo.
 * ============================================================================
 */

#include <DigiMouse.h>

/* ----------------------------- Configuración ----------------------------- */
#define PASO_PX        4      // píxeles por paso (1..127)
#define PASOS_POR_LADO 6      // pasos por lado del cuadro
#define INTERVALO_MS   25     // ms entre pasos (NO bajar de 20)
#define DESCANSO_MS    5000   // espera entre ciclos
#define ARRANQUE_MS    2000   // espera inicial para que el SO detecte el mouse
#define HACER_CLICK    0      // 1 = click izquierdo una vez por ciclo
#define USAR_RUEDA     0      // 1 = además mueve la rueda

/* Máscaras de botones (definidas en DigiMouse.h) */
#define BTN_IZQ 0x01
#define BTN_DER 0x02
#define BTN_MED 0x04

/* ------------------------------- Utilidades ------------------------------- */

// Da 'veces' pasos de (dx, dy). Cada paso se transmite dentro del delay().
void pasos(int dx, int dy, int veces) {
  for (int i = 0; i < veces; i++) {
    DigiMouse.move((char)dx, (char)dy, 0);  // movimiento relativo, en píxeles
    DigiMouse.delay(INTERVALO_MS);
  }
}

// Mueve el cursor 'dx'/'dy' píxeles en total, troceando en saltos de <=127.
void moverPixeles(long dx, long dy) {
  while (dx != 0 || dy != 0) {
    char sx = (char)constrain(dx, -127L, 127L);
    char sy = (char)constrain(dy, -127L, 127L);
    DigiMouse.move(sx, sy, 0);
    DigiMouse.delay(INTERVALO_MS);
    dx -= sx;
    dy -= sy;
  }
}

// Click sostenido 'ms' milisegundos (1 = izquierdo, 2 = derecho, 4 = medio).
void click(byte boton, int ms) {
  DigiMouse.setButtons(boton);
  DigiMouse.delay(ms);
  DigiMouse.setButtons(0);   // sin esto el botón queda apretado
  DigiMouse.delay(INTERVALO_MS);
}

/* --------------------------------- Sketch --------------------------------- */

void setup() {
  DigiMouse.begin();      // reenumera el USB como mouse (obligatorio)
  DigiMouse.delay(ARRANQUE_MS);
}

void loop() {
  // Recorrido en cuadro: al cerrar el ciclo el cursor vuelve donde empezó.
  pasos( PASO_PX,   0, PASOS_POR_LADO);   // derecha
  pasos( 0,  PASO_PX, PASOS_POR_LADO);   // abajo
  pasos(-PASO_PX,   0, PASOS_POR_LADO);   // izquierda
  pasos( 0, -PASO_PX, PASOS_POR_LADO);   // arriba

#if HACER_CLICK
  // CUIDADO: hace click donde esté el cursor en ese momento.
  click(BTN_IZQ, 80);
#endif

#if USAR_RUEDA
  DigiMouse.scroll(2);
  DigiMouse.delay(INTERVALO_MS);
  DigiMouse.scroll(-2);
  DigiMouse.delay(INTERVALO_MS);
#endif

  DigiMouse.delay(DESCANSO_MS);
}

/* ------------------------------- Ejemplos ----------------------------------
 *
 * Mover el cursor a la derecha 300 px (sin tocar el sketch de arriba):
 *     moverPixeles(300, 0);
 *
 * Subir la rueda 3 "clics":
 *     for (int i = 0; i < 3; i++) { DigiMouse.scroll(1); DigiMouse.delay(INTERVALO_MS); }
 *
 * Arrastrar (mantener el botón mientras se mueve):
 *     DigiMouse.setButtons(BTN_IZQ);
 *     moverPixeles(100, 100);
 *     DigiMouse.setButtons(0);
 *     DigiMouse.delay(INTERVALO_MS);
 *
 * Movimiento continuo y suave (sin descansos): quita el DigiMouse.delay(DESCANSO_MS)
 * y baja PASOS_POR_LADO. Nunca quites todos los delays.
 * -------------------------------------------------------------------------- */
