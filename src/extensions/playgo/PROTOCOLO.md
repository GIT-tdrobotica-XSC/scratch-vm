# Protocolo serial PlayGo

Este documento especifica el protocolo de comunicación entre PlayCode (Scratch) y el
firmware de la placa PlayGo (ESP32-S3 MINI), para que el equipo de firmware lo
implemente. Es el **mismo formato** que ya usan PlayMe y PlayIoT en producción — se
replica intencionalmente para reutilizar el mismo enfoque probado.

## Transporte

- **Web Serial API** desde el navegador (`navigator.serial`), `baudRate: 115200`, sin
  control de flujo adicional.
- **Corrección (confirmado con el esquemático playGo_V7.1):** a diferencia de lo que
  se asumió al inicio, PlayGo **sí** tiene un puente **CH340K** (UART3) con un
  circuito de auto-reset por DTR/RTS (transistores + flip-flop), igual que PlayIoT —
  **no** es USB-JTAG nativo puro como PlayMe. El lado GUI ya trata a PlayGo como
  PlayIoT para el flasheo (`bootloaderAddress = 0x1000`, reset por pulso DTR/RTS,
  reconexión no-inmediata). Pendiente de confirmar en hardware real si el circuito de
  auto-reset (con flip-flop, más elaborado que el de PlayIoT) permite saltarse el paso
  manual de "mantén BOOT presionado" — por ahora se dejó igual de conservador que
  PlayIoT hasta poder probarlo.
- El esquemático también muestra un conector USB adicional ("USB MAIN", directo a los
  pines USB nativos del ESP32-S3) aparte del puerto con CH340 ("USB HOST"). Falta
  confirmar en la placa real cuál de los dos es el que efectivamente usa el navegador
  para Web Serial.

### Bluetooth LE (v2.0)

Además del USB, el firmware expone el **mismo protocolo JSON-por-línea via BLE**
(servicio **Nordic UART / NUS**), y la GUI se conecta con **Web Bluetooth** (Chrome/
Edge). En el modal de conexión aparecen dos opciones: "PlayGo por USB" y "PlayGo por
Bluetooth"; el picker nativo del navegador se abre al elegir una.

**Por qué BLE y no un COM virtual Bluetooth:** el COM virtual del sistema lo provee
el perfil SPP, que corre sobre **Bluetooth Classic (BR/EDR)** — y el **ESP32-S3 no
tiene Bluetooth Classic, solo BLE**. No existe firmware que haga aparecer la PlayGo
como puerto COM Bluetooth en Windows; la alternativa correcta sin instalar nada en
los PCs es hablar BLE directo desde el navegador.

Detalles técnicos (implementados en `playgo-ble.js` GUI / NimBLE firmware):
- UUIDs estándar del NUS: servicio `6E400001-...`, RX `6E400002-...` (GUI→placa,
  write), TX `6E400003-...` (placa→GUI, notify).
- La placa se anuncia como **"PlayGo"** e incluye el UUID del servicio en el
  advertising (la GUI filtra por él: solo aparecen placas PlayGo en el picker).
- Fragmentación: la GUI trocea sus writes a 20 bytes (payload garantizado con
  cualquier MTU); el firmware pide MTU 517 y trocea la telemetría al MTU negociado
  (con Chrome/Windows la telemetría completa suele caber en 1 notificación). Ambos
  lados re-ensamblan por el delimitador `\n`, así que la fragmentación es
  transparente para el protocolo.
  **Bug corregido (firmware v2.0.2):** el troceo debe usar el MTU **negociado
  real** (`getPeerMTU`), no el preferido (`getMTU()` devuelve el 517 local aunque
  el central haya negociado menos) — NimBLE recorta en silencio cada notify que
  exceda el MTU real, y la telemetría llegaba truncada/mezclada ("JSON inválido"
  en consola; los bloques de movimiento quedaban colgados en rojo hasta su
  timeout porque nunca veían el `moveDone`).
- Latencia: el firmware solicita un intervalo de conexión de 15-30ms
  (`updateConnParams`, default de Windows ~30-60ms) y supervision timeout de
  4s para tolerar microcortes de radio sin caer el enlace.
  **Corregido en v2.0.5:** pedirlo inline en `onConnect` (como hacía v2.0.4,
  con un intervalo aún más agresivo de 7.5-15ms) tumbaba el enlace a los 2-3s
  — Windows a veces rechaza/renegocia parámetros tan cortos mientras el MTU
  todavía se está negociando. Ahora se pide una sola vez, 1.5s después de
  conectar (`bleTick`), con valores más conservadores.
- **Telemetría corrupta justo al conectar (corregido, fw v2.0.5):** la
  telemetría arrancaba de inmediato tras `onConnect`, antes de que el MTU
  grande (517) terminara de negociarse — cada línea de telemetría (~380
  bytes) viajaba en hasta 19 notificaciones de 20 bytes cada 100ms,
  saturando el enlace recién establecido (NimBLE descarta notificaciones en
  silencio si su cola se llena). `bleSendLine` ahora espera 1.5s desde la
  conexión antes de mandar nada.
- **Latencia general de ~1s en TODO comando (corregido, fw v2.0.8 + GUI):**
  v2.0.5 pasó a confiar solo en el callback `onMTUChange` para conocer el
  MTU; si no se dispara, el firmware asume MTU 23 para siempre y la
  telemetría (~400 bytes cada 100ms) se trocea en ~20 notificaciones de 20
  bytes = ~200 notif/s — más de lo que el radio drena por evento de
  conexión. El backlog crecía sin límite y cualquier comando entrante (un
  simple click de LED, sin scripts corriendo) quedaba detrás, con ~1s de
  espera. Fixes: (a) `bleEffectiveMtu()` combina el callback con polling de
  `getPeerMTU` como respaldo; (b) telemetría BLE con **intervalo
  adaptativo** — 10Hz si el MTU permite 1 notificación por línea, 2.5Hz si
  quedó en el mínimo (nunca satura); (c) el firmware loguea el MTU efectivo
  en el monitor serial (si sale 23, el central no negoció MTU grande); (d)
  del lado GUI, si el tamaño de las notificaciones recibidas prueba que el
  MTU es grande, cada comando va en UN solo write en vez de 5+ trozos de 20
  bytes (menos latencia de subida).
- **Desconexiones inesperadas bajo ráfagas (corregido, fw v2.0.4 + GUI):** el
  `onWrite` de NimBLE corre en la tarea del stack BLE; parsear y ejecutar ahí
  cada comando (incluyendo hardware lento como el I2C del OLED) bloqueaba esa
  tarea bajo flood de comandos → el stack no atendía el enlace → timeout de
  supervisión → desconexión. El firmware ahora solo encola bytes en `onWrite`
  (ring buffer con critical section) y los procesa en `loop()` (`bleRxTick`),
  igual que el serial USB. Del lado GUI: los bloques RGB se deduplican (mismo
  esquema que motores/notas — un "por siempre" reenviaba el mismo `setRGB`
  ~30-60 veces/segundo) y las escrituras BLE de scripts concurrentes se
  serializan en una cadena de promesas (sin eso, los trozos de 20 bytes de dos
  scripts simultáneos se intercalaban corrompiendo ambas líneas JSON).
- Ambos transportes conviven: el firmware procesa comandos de cualquiera de los dos
  y emite la telemetría por ambos. Al desconectarse el BLE, vuelve a anunciarse solo.
- **La actualización de firmware sigue requiriendo USB** (esptool necesita el puerto
  serial físico) — no se puede flashear por BLE.
- Requiere en `platformio.ini`: `h2zero/NimBLE-Arduino @ ^1.4` (y si el binario no
  cabe en la partición por defecto: `board_build.partitions = huge_app.csv`).

## Framing

- Cada mensaje es **un JSON completo por línea**, terminado en `\n`.
- **Sin checksum, CRC ni longitud de payload.** La integridad depende de que la línea
  parsee con `JSON.parse` y de que empiece con `{` y termine con `}`.
- El lado GUI recorta su buffer de recepción si supera 1024 caracteres sin encontrar
  un mensaje completo (protección anti-crecimiento) — el firmware debe evitar mandar
  líneas más largas que eso.

## GUI → placa (comandos)

Envelope fijo:

```json
{"command":"outputsQueue","testValue":[ {"command":"<subcomando>", ...campos} ]}
```

`testValue` es un array (permite lote), pero en la práctica cada bloque de Scratch
manda un solo subcomando por mensaje.

### Motores

**⚠️ Encoder de un solo canal (confirmado por Mauricio Velandia, hardware).** Cada
rueda tiene 2 pines de encoder ruteados en el esquemático (CHA/CHB), pero **solo uno
está realmente conectado/funcional** — es una limitación de hardware, no un error de
esta extensión. Se usa el **canal A** (GPIO 16 izquierdo, GPIO 36 derecho); el canal B
(GPIO 15/35) no se usa. Consecuencia directa: el encoder **solo cuenta pulsos, no
puede determinar la dirección de giro por sí mismo** (para eso se necesitan los 2
canales en cuadratura). El firmware debe **inferir la dirección desde el último
comando de PWM enviado a esa rueda** (guardar el signo de `left`/`right` de
`setMotorSpeed`/`moveDistance`/etc. y aplicar ese signo al incrementar/decrementar el
contador de pulsos en la interrupción), no leyendo un segundo canal.

| Subcomando | Campos | Descripción |
|---|---|---|
| `setMotorSpeed` | `left:Number(-100..100)`, `right:Number(-100..100)` | Velocidad directa de cada rueda, lazo abierto (sin encoder). Negativo = reversa. |
| `stopMotors` | — | Detiene ambos motores inmediatamente. |
| `moveDistance` | `moveId:Int`, `distanceCm:Number`, `speed:Number(-100..100)`, `wheelDiameterCm:Number`, `pulsesPerRev:Int` | Avanza en línea recta la distancia indicada, usando el encoder como lazo cerrado. El firmware calcula los pulsos objetivo con `distanceCm / (π * wheelDiameterCm) * pulsesPerRev`. |
| `turnAngle` | `moveId:Int`, `angleDeg:Number`, `speed:Number(-100..100)`, `wheelDiameterCm:Number`, `trackWidthCm:Number`, `pulsesPerRev:Int` | Gira el robot en su propio eje el ángulo indicado (positivo = sentido horario). Diferencial: cada rueda gira en sentido opuesto una distancia de arco `angleDeg/360 * π * trackWidthCm`. |
| `turnWheelRevs` | `moveId:Int`, `wheel:'left'|'right'|'both'`, `revolutions:Number`, `speed:Number(-100..100)`, `pulsesPerRev:Int` | Gira la(s) rueda(s) indicada(s) el número de vueltas exacto (control directo por encoder, sin conversión a distancia). |
| `resetEncoders` | — | Pone en 0 los contadores acumulados `encoderLeft`/`encoderRight` de la telemetría. |
| `servoWrite` | `pin:Int(11,12,13,14)`, `angle:Int(0-180)` | Mueve el servo conectado en el puerto especial A/B/C/D (= GPIO 11/12/13/14 respectivamente, serigrafía de la placa). Mismo GPIO que `digitalWrite` de playBlocks/play+ — el firmware decide el modo según cuál de los dos comandos reciba para ese pin. Deduplicado del lado GUI igual que `setMotorSpeed`/RGB. |

**Bug de servos en ESP32-S3 corregido (fw v2.0.6)** — "no deja más de 2 servos,
se bloquean los pines" es un bug **documentado de la librería ESP32Servo**,
específicamente en ESP32-S3 (no exclusivo de este proyecto — reportes
idénticos en el
[foro de Arduino](https://forum.arduino.cc/t/esp32-s3-not-working-with-2-servos/1157409)
y el [issue #35 de la librería](https://github.com/madhephaestus/ESP32Servo/issues/35)).
Causa: sin reservar explícitamente los 4 timers de hardware antes del primer
`attach()`, la librería los asigna de forma implícita y colisiona consigo
misma a partir del 3er servo. Fix: `ESP32PWM::allocateTimer(0..3)` al inicio
de `setup()`, antes de cualquier uso de servo.
Se descartó un segundo intento (cambiar el pin inactivo de cada motor de
`analogWrite(pin,0)` a `digitalWrite(pin,LOW)` para "liberar" canales LEDC)
tras verificar que es un bug conocido del core Arduino-ESP32
([issue #9057](https://github.com/espressif/arduino-esp32/issues/9057)):
`digitalWrite()` después de `analogWrite()` en el **mismo pin** no apaga el
PWM de forma confiable, y el canal LEDC queda asignado al pin desde el primer
`analogWrite()` sin importar qué función se llame después — no liberaba nada
y habría introducido un bug nuevo.

**Segundo bug de servos — "los servos se combinan" (resuelto DEFINITIVO en fw
v2.0.9)** (el servo del puerto B se movía a la par con el C, el de A con el
C, al conectar el 3ro). Se intentaron dos fixes intermedios que NO lo
resolvieron: v2.0.6 (`allocateTimer(0..3)`) y v2.0.7 (motores migrados de
`analogWrite` al asignador `ESP32PWM` de la librería, para unificar el
reparto de canales). El espejo persistió en hardware real. Causa de fondo:
ESP32Servo 3.x está escrita para el core Arduino 3.x, y sobre el core 2.x
(platform `espressif32` oficial de PlatformIO) corre en capa de
compatibilidad con bookkeeping de canales LEDC poco confiable en el S3.
**Solución definitiva: eliminar ESP32Servo por completo.** Todo el PWM usa
la API LEDC del core directamente con canales fijos asignados a mano
(un canal = un pin, inmutable): motores ch0-3 @1kHz (timers 0-1), servos
ch4-7 @50Hz (timers 2-3); pulso de servo estándar 544-2400µs. La librería
se quitó también de `platformio.ini`.

**Corrección crítica sobre v2.0.9 (fw v2.0.10):** la primera versión del
LEDC directo configuraba los canales de servo con resolución de **16 bits**
— válida en el ESP32 clásico (llega a 20 bits) pero **el ESP32-S3 solo llega
a 14** (`SOC_LEDC_TIMER_BIT_WIDTH=14`, doc oficial de Espressif). En el S3,
`ledcSetup(ch, 50, 16)` falla **en silencio** (retorna 0, no configura el
timer, ningún error) y el canal jamás genera señal — los servos pasaron de
"espejados" a "muertos". Fix: 14 bits (16384 cuentas por período de 20ms,
~8 pasos por grado, precisión de sobra) + chequeo del retorno de `ledcSetup`
con error visible en el monitor serial. Lección para futuros ports: las
resoluciones LEDC válidas dependen del chip exacto, y la API falla sin
avisar. Verificado: compila limpio con ESP32Servo fuera del grafo de
dependencias.

**Deduplicación de `servoWrite` corregida a POR PIN (GUI):** el caché único
inicial hacía ping-pong con 2+ servos activos en scripts paralelos (el
comando del servo C pisaba el caché del D y viceversa), reenviando todo ~60
veces/segundo aunque los ángulos no cambiaran — ese flood saturaba el BLE y
era la causa de la "latencia alta" reportada tras agregar los servos.

**Deduplicación del lado GUI (`setMotorSpeed`/`stopMotors`)** — patrón típico
"control por teclado": `por siempre: si <tecla> entonces Motores... si no
Detener motores` reevalúa el bloque ~30-60 veces/segundo. Sin deduplicar, cada
vuelta reenvía el mismo comando aunque el estado no haya cambiado, saturando
el transporte (sobre todo BLE, con latencia por escritura) — el comando real
(al presionar/soltar la tecla) queda encolado detrás de decenas de duplicados,
sintiéndose como lag entre la tecla y que el robot reaccione. `blocks.js`
ahora cachea el último estado enviado (`_lastMotorState`) y solo reenvía si
cambió. Los tres comandos de movimiento (`moveDistance`/`turnAngle`/
`turnWheelRevs`) invalidan ese caché al terminar, porque el firmware frena los
motores por su cuenta y la GUI no debe asumir que el estado sigue siendo el de
antes del movimiento.

**Semántica de `moveId`/`moveDone`** (crítico): los tres comandos de movimiento
(`moveDistance`, `turnAngle`, `turnWheelRevs`) son de **larga duración**. El lado
Scratch no bloquea esperando una respuesta directa — en cambio, hace polling sobre la
telemetría (`inputs.moveId`/`inputs.moveDone`) con un timeout de seguridad. El firmware
debe:
1. Al recibir un comando de movimiento, guardar su `moveId` y comenzar la maniobra en
   background (motor PID/step local, sin bloquear el resto del firmware).
2. Mientras el movimiento esté en curso, reportar `moveDone:0` en cada paquete de
   telemetría normal.
3. Al terminar (por alcanzar el objetivo o por timeout interno de seguridad),
   reportar `moveId:<el mismo id>` y `moveDone:1`, y **mantenerlo en 1** hasta que
   llegue un nuevo comando de movimiento — el polling del lado GUI no depende de
   recibir un paquete "evento único", sino de ver ese estado en cualquier paquete de
   telemetría normal que llegue después.

### RGB (10 LEDs direccionables, un solo GPIO — WS2812/NeoPixel asumido)

| Subcomando | Campos | Descripción |
|---|---|---|
| `setRGB` | `led?:Int(0-9)`, `r:Int(0-255)`, `g:Int(0-255)`, `b:Int(0-255)` | Si `led` está presente, cambia solo ese LED; si se omite, aplica el color a los 10 LEDs. |

### Pantalla OLED (SH1107, I2C)

**Corrección final confirmada con un script de prueba del equipo de hardware:**
el controlador **SÍ direcciona 128x128 nativo** (la ficha original tenía razón),
pero el **vidrio visible es más chico (~96x96) y está centrado dentro de ese
lienzo físico** — no es que el panel "sea" 96x96, es que solo se ve una ventana
recortada de un área direccionable mayor. El script de prueba confirmó esto
dibujando con `blit(fb, 15, 15)` sobre un display inicializado como 128x128 con
los valores **estándar** de esa configuración (`multiplex=0x7F`, `offset=0x00`
— los mismos que ya trae por defecto cualquier librería SH1107 bien soportada
para 128x128, sin necesidad de valores inventados).

Implementación correcta: inicializar el controlador como 128x128 con los valores
estándar (no reducir el tamaño declarado), y aplicar un **desplazamiento de
coordenadas de +16px en X e Y** a todo lo que dibujan los bloques de Scratch —
así el área lógica de 96x96 que usan los bloques (`oledDrawLine`, `oledTextXY`,
etc., coordenadas 0-95) queda centrada dentro del vidrio visible real. El offset
de 16px es el centrado matemático exacto ((128-96)/2); el script de referencia
usó 15px por preferencia visual de margen para su logo — si al probar la imagen
no queda perfectamente centrada, ajustar este valor en 1-2px.

Mismo set de comandos que ya usa PlayMe (reutilizado tal cual):

| Subcomando | Campos |
|---|---|
| `oledText` | `text:String`, `size:Int(1-3)` |
| `oledNumber` | `line:Int(0-3)`, `label:String`, `value:Int` |
| `oledClear` | — |
| `oledLine` | `line:Int(0-3)`, `text:String` |
| `oledTextXY` | `text:String`, `x:Int`, `y:Int`, `size:Int(1-3)` |
| `oledEmoji` | `emoji:String` (uno de: `smile,sad,heart,star,alert,question,check,cross,arrow_up,arrow_down,arrow_right,arrow_left,music,thermometer,wifi`), `x:Int`, `y:Int` |
| `oledDrawLine` | `x0:Int`, `y0:Int`, `x1:Int`, `y1:Int` |
| `oledDrawRect` | `x:Int`, `y:Int`, `w:Int`, `h:Int` |
| `oledFillRect` | `x:Int`, `y:Int`, `w:Int`, `h:Int` |
| `oledDrawCircle` | `x:Int`, `y:Int`, `r:Int` |
| `oledDrawPixel` | `x:Int`, `y:Int` |
| `oledDisplay` | — (fuerza refresco de pantalla si el firmware buffer-ea el dibujo) |

**Comportamiento de refresco (v2.0.3, reemplaza el esquema de v1.6):** todos los
`oled*` (excepto `oledDisplay`) escriben solo en el framebuffer en RAM y marcan
la pantalla como pendiente; un **auto-flush con límite de frecuencia** en el
loop del firmware vuelca el framebuffer al panel como máximo cada 100ms cuando
hay dibujo pendiente. Resultado: los bloques OLED funcionan solos (no requieren
terminar con "OLED actualizar pantalla"), pero el costo del volcado por I2C
queda acotado a 10Hz (~6ms por flush con I2C a 400kHz) y no produce el lag en
motores/RGB de v1.5 (donde CADA figura volcaba los 128x128px completos de
inmediato). Historia: v1.6 quitó el flush automático por completo y exigía el
bloque "OLED actualizar pantalla" al final de cada secuencia — eso arregló el
lag pero rompió la usabilidad (dibujar "no hacía nada" sin ese bloque).
`oledDisplay` sigue existiendo y fuerza un volcado inmediato, útil para
sincronizar el refresco a mano (por ejemplo animaciones).

### Audio

| Subcomando | Campos | Descripción |
|---|---|---|
| `tone` | `freq:Number(Hz)`, `durationMs:Number` | Reproduce un tono simple por el I2S de salida. No bloqueante del lado firmware (debe poder recibir otros comandos mientras suena). `durationMs:0` = sonar indefinidamente (no se auto-apaga), usado por el bloque "Mantener nota" — solo `toneStop` lo corta. |
| `toneStop` | — | Corta el tono en curso (incluye los sostenidos con `durationMs:0`). |

Los bloques "Reproducir nota" y "Mantener nota" (Do/Re/Mi/Fa/Sol/La/Si + octava)
son puramente del lado GUI: convierten nota+octava a Hz (temperamento igual,
A4=440Hz) y envían el mismo subcomando `tone` de arriba. El firmware no
necesita saber nada de notas musicales.

**"Mantener nota" / "Soltar nota"** (`holdNote`/`releaseNote` en blocks.js) son
para el patrón "nota constante mientras un botón está oprimido". "Mantener
nota" no espera ninguna duración — envía `tone` con `durationMs:0` y retorna de
inmediato, para que el bucle pueda seguir revisando el botón. "Soltar nota"
detiene el sonido **solo si esa nota específica es la que está sostenida**.

La GUI lleva registro de la nota sostenida (`_heldFreq`) y con eso:
- **deduplica**: reevaluar "Mantener nota" con la misma nota ~30 veces/seg (lo
  normal dentro de un por-siempre) envía el comando UNA sola vez, no satura el
  serial;
- **aísla cada botón**: en un "piano" de varios `si/si no` planos dentro del
  mismo por-siempre, el `si no → Soltar nota X` de un botón NO oprimido no hace
  nada si lo que suena es otra nota — no mata la nota del botón que sí está
  oprimido. (Con "Detener tono" genérico en cada rama else, cada botón no
  oprimido apagaba la nota de los demás ~30 veces por segundo: sonido
  entrecortado o mudo. "Detener tono" sigue existiendo como corte global.)

Uso típico (repetir el par por cada botón/nota dentro del mismo por-siempre):
```
por siempre:
  si <botón B1 oprimido> entonces
    Mantener nota Re octava 7
  si no:
    Soltar nota Re octava 7
  si <botón B2 oprimido> entonces
    Mantener nota Mi octava 7
  si no:
    Soltar nota Mi octava 7
  ...
```
Es monofónico (un solo generador de tono en el firmware): si se oprimen dos
botones a la vez, suena el último que se evaluó.

**Octavas 1-3 confirmadas inaudibles** en el parlante pequeño de PlayGo (~33-247Hz,
fuera del rango que reproduce el hardware). El menú `OCTAVE` del bloque se restringió
a 4-7 (rango confirmado audible desde octava 4). Si al probar se confirma que 7 también
se degrada o que se puede bajar a 3, ajustar el menú `musicOctaves` en `blocks.js`.

No hay comando de streaming de audio — el protocolo no lo soporta (JSON por línea,
no binario). El micrófono solo reporta un nivel agregado (ver telemetría).

**Nota de firmware — bug de audio "frecuencias raras" confirmado y corregido:**
el MAX98357A, con el pin SD flotante (cableado típico del breakout, mezcla
`(L+R)/2`), necesita que el firmware envíe I2S en modo **estéreo** con la misma
muestra duplicada en ambos canales. Configurarlo como `I2S_CHANNEL_FMT_ONLY_LEFT`
(mono, un solo canal con datos) deja el canal derecho sin definir; el ampli
mezcla el tono real con esa basura y suena distorsionado/con tono incorrecto.
Fix: `I2S_CHANNEL_FMT_RIGHT_LEFT` + escribir cada muestra dos veces (L y R).

**Segundo bug de audio confirmado y corregido (v1.8, tras un intento fallido
en v1.7)** — el fix de canales no era suficiente: seguía sonando "a ruido,
ninguna nota reconocible". Eran DOS causas combinadas:

1. **Firmware**: `i2s_write()` no bloqueante descarta el bloque cuando el DMA
   está lleno, pero el acumulador de fase (`tonePhase`) avanzaba igual —
   desincronizando la fase de la onda emitida (ruido en vez de tono). El
   primer intento de fix (v1.7: write bloqueante con `portMAX_DELAY`) trababa
   `loop()` entero esperando al DMA — motores y serial con lag. **Fix real
   (v1.8)**: write no bloqueante + avanzar `tonePhase` solo por los frames
   que el DMA aceptó de verdad (`written`). Además `tx_desc_auto_clear=true`
   (en underrun el DMA repetía el último buffer en loop: basura audible) y
   `silenceI2S()` vía `i2s_zero_dma_buffer()` (instantáneo, no bloqueante).

2. **GUI (`blocks.js`)**: `playTone`/`playNote` enviaban el comando y
   retornaban de inmediato, sin esperar `durationMs`. Una secuencia de bloques
   de notas (Do→Re→Mi) llegaba al firmware en milisegundos y cada `tone`
   pisaba al anterior — por eso "no suena ninguna escala". Fix: los bloques
   ahora esperan la duración antes de soltar el hilo de Scratch, igual que
   los bloques de música nativos de Scratch.

**Tercer bug de audio confirmado y corregido (v1.9)** — tonos largos (ej.
5000ms) sonaban entrecortados, "como si se repitiera". Causa: la telemetría
(cada 100ms) manda un JSON de ~300-400 bytes por `Serial.println()`; el
buffer TX por defecto del ESP32 es de 256 bytes, así que ese `println()` se
bloqueaba esperando a transmitir los bytes sobrantes — cortando el audio en
ese instante, cada 100ms. Fix: `Serial.setTxBufferSize(1024)` antes de
`Serial.begin()`.

### Entradas/Salidas playBlocks y play+

Los módulos playBlocks y play+ comparten los mismos 4 conectores de entrada (IO1-IO4,
serigrafía "1","2","3","4") y 4 conectores de salida (IO11-IO14, serigrafía "A","B","C","D")
— el conector/módulo físico cambia, no el pin.

| Subcomando | Campos | Descripción |
|---|---|---|
| `digitalWrite` | `gpio:Int(11,12,13,14)`, `value:0|1` | Escribe una salida playBlocks/play+ (IO11-IO14 / A-D). |
| `setIOMode` | `mode:'playBlocks'\|'play+'` | Configura el módulo de extras conectado. Ver sección "Modo IO (GPIO 21 / señal ENB_PB)" más abajo. |

Las entradas (IO1-IO4) **no** tienen comando de escritura — se leen pasivamente vía
telemetría, en dos formas simultáneas (el firmware reporta ambas del mismo pin físico,
el bloque de Scratch usado decide cuál interpretación aplica):
- `inputs.gpio1..4` (0/1): lectura digital, para botones/sensores digitales conectados ahí.
- `inputs.pot1..4` (0-4095, ADC de 12 bits): lectura analógica, para el potenciómetro.

**⚠️ Bug de firmware encontrado y corregido probando en hardware real:** en el
ESP32, llamar `analogRead()` en un pin deja ese pin reconfigurado en modo ADC — un
`digitalRead()` posterior en el **mismo pin** no vuelve a leer digital correctamente
a menos que se llame `pinMode(pin, INPUT)` de nuevo primero. Como la telemetría lee
`gpio1..4` (digital) y `pot1..4` (analógico) de los mismos 4 pines en cada ciclo, sin
este `pinMode()` explícito antes de cada `digitalRead()` el valor digital queda
siempre en `0` (confirmado: el potenciómetro funcionaba pero la entrada digital
booleana daba siempre `false`). El firmware debe hacer `pinMode(pin, INPUT)`
inmediatamente antes de cada `digitalRead()` de IO1-4, en cada ciclo de telemetría.

### Modo IO (GPIO 21 / señal ENB_PB)

**Corregido tras revisar el esquemático detallado del MCU (U12, ESP32-S3-MINI-1):**
el selector de modo NO es el GPIO 33 (esa idea venía de una lectura previa del
diagrama "Funcionamiento playGo!", ambigua). El esquemático del MCU muestra una señal
dedicada **`ENB_PB` en GPIO 21**, separada del I2C — confirmado por el usuario. GPIO 33
es únicamente la línea SDA del I2C interno, sin doble función; el `setIOMode` puede
implementarse como un simple `digitalWrite` en GPIO 21 en cualquier momento, **sin**
el conflicto ni el manejo especial de I2C que se pensaba antes.

- **GPIO 21 (ENB_PB) = selector de modo**: **corregido en hardware real — HIGH =
  módulo playBlocks, LOW = módulo play+** (la polaridad asumida originalmente
  (LOW=playBlocks, HIGH=play+) estaba invertida: al probar en la placa, seleccionar
  "play+" encendía el indicador LED de "playBlocks" y viceversa).
- En modo **playBlocks**: IO1-4 son SIEMPRE entrada, IO11-14 (A-D) son SIEMPRE salida (fijo,
  es lo que ya implementan `readDigitalPB`/`analogReadPB`/`writeDigitalPB`/`servoWrite`).
- En modo **play+**: **confirmado por Mauricio Velandia (hardware)** — los puertos
  quedan igual de FIJOS que en playBlocks (cada uno es entrada o es salida, no
  configurable dinámicamente por software). No hay diferencia funcional de
  entradas/salidas entre los dos modos a nivel de firmware; `setIOMode` solo
  cambia qué tipo de módulo físico está habilitado.

## Placa → GUI (telemetría)

```json
{
  "inputs": {
    "button_0": 0, "button_1": 0, "button_2": 0, "button_3": 0,
    "button_4": 0, "button_5": 0, "button_6": 0, "button_7": 0,
    "gpio1": 0, "gpio2": 0, "gpio3": 0, "gpio4": 0,
    "pot1": 0, "pot2": 0, "pot3": 0, "pot4": 0,
    "encoderLeft": 0, "encoderRight": 0,
    "moveId": 0, "moveDone": 1,
    "micLevel": 0
  },
  "version": "1.0.0"
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `button_0`..`button_7` | 0/1 | Lectura binaria de los 8 botones (serigrafía B0-B7), vía expansor I2C PCF8574. Arreglados como dos cruces direccionales de 4 botones (B0-B3 a la izquierda del OLED, B4-B7 a la derecha). |
| `gpio1`..`gpio4` | 0/1 | Lectura digital de IO1-IO4 (playBlocks/play+). |
| `pot1`..`pot4` | 0-4095 | Lectura analógica (ADC 12 bits) de los mismos IO1-IO4, para el potenciómetro. |
| `encoderLeft`/`encoderRight` | Int | Conteo acumulado de pulsos IRQ de cada encoder. No se resetea solo — solo vía `resetEncoders`. |
| `moveId`/`moveDone` | Int / 0\|1 | Ver semántica arriba. |
| `micLevel` | Int (0-100 sugerido) | Nivel de sonido agregado del micrófono I2S (ej. RMS de una ventana de ~100ms, mapeado a 0-100). **Etapa 2** — no es parte del alcance actual, dejado documentado para cuando se implemente. |
| `version` | String | Versión de firmware (`x.y.z`), comparada contra `https://playcode.tdrobotica.co/firmware/playgo/version.txt` para detectar firmware desactualizado. |

El paquete de `inputs` debe enviarse periódicamente (igual que PlayMe/PlayIoT hoy, no
especificado un intervalo exacto en este documento — replicar el mismo período que ya
usan esas placas).

## Notas de hardware (según plano de la placa)

- **No hay LED de inicio dedicado.** La nota original (de la reunión previa, "LED de
  inicio blink" en GPIO 33) no corresponde a ningún pin real confirmado en los
  esquemáticos — se descarta. GPIO 33 es únicamente SDA del I2C interno; el selector
  de modo es GPIO 21 (ENB_PB), ver sección "Modo IO" arriba. Si se quiere una
  animación de arranque, usar el RGB (GPIO 48, confirmado) en vez de un LED dedicado.
- **Botones vía PCF8574** — **dirección real confirmada por `i2c.scan()` en hardware:
  `0x21`, no `0x20`** como decía el esquemático (A0 debe estar en HIGH en vez de GND
  en la unidad física probada). El firmware lee los 8 botones (B0-B7) por ese chip y
  los reporta ya traducidos como `button_0..7` en la telemetría — no cambia nada del
  protocolo GUI↔firmware descrito arriba, es un detalle interno.
- **I2C interno confirmado: SDA = GPIO 33, SCL = GPIO 34** (botones PCF8574 + pantalla
  OLED), consistente entre la ficha original, el diagrama de modos y el esquemático
  del MCU.
- **Header I2C genérico** (GND/3.3V/SCL/SDA, aparte del bus interno de botones/OLED):
  pensado para conectar sensores externos (ultrasonido, sensor de línea) en una
  etapa futura. Sin bloques ni comandos definidos todavía — pendiente de ver qué
  módulos exactos se conectan ahí.
- **Motores: 2x DRV8833** (driver H-bridge dual, uno por rueda). Control estándar de
  ese chip: PWM en `xIN1` con `xIN2=LOW` = un sentido, PWM en `xIN2` con `xIN1=LOW` =
  el otro, ambos en LOW = coast (rueda libre), ambos en HIGH = brake.
  **Pines confirmados por el esquemático del MCU (corrigiendo una inversión de la
  ficha original):** motor **izquierdo** en GPIO 17/18 (driver) + GPIO 16 (encoder,
  un solo canal — GPIO 15 sin usar); motor **derecho** en GPIO 37/38 (driver) +
  GPIO 36 (encoder, un solo canal — GPIO 35 sin usar). La ficha original tenía los
  dos lados invertidos. Ver sección "Motores" arriba para el detalle del encoder de
  un solo canal y cómo se infiere la dirección.
- **Audio confirmado por el usuario:** parlante (I2S salida, MAX98357A) en BCK=8,
  WS=9, DOUT=10. Micrófono (I2S entrada, etapa 2) en SCK=5, WS=6, SD=7.
- **Parlante: MAX98357A** (amplificador clase D vía I2S — pines SD/SCLK/LRCLK/DIN).
  El tono (`tone`/`toneStop`) se genera sintetizando una onda (seno) y sacándola por
  I2S estándar; el pin `SD` debe quedar habilitado para que el ampli no esté en
  shutdown.
- **Display: boost a 13V (MT3608) confirmado como automático/pasivo.** El conector
  del display (X2, GND/3.3V/SDA/SCL/VPP) no tiene ningún pin de "enable" — el boost
  arranca solo con la alimentación de 3.3V. El firmware puede inicializar el OLED
  directo, sin necesidad de prender ningún GPIO adicional antes.

## Etapa 2 (fuera del alcance actual)

Explícitamente diferido hasta después del demo inicial (LED + motores + pantalla):
- Micrófono (nivel de sonido, ya documentado arriba como referencia futura).
- Sensores externos por el header I2C genérico (ultrasonido, línea).

## Actualización de firmware (esptool-js)

**Corregido tras revisar el esquemático v7.1**: PlayGo se trata igual que **PlayIoT**
en `scratch-gui/src/components/sprite-selector/firmware-updater-modal.jsx` (puente
CH340 + auto-reset por DTR/RTS), no como PlayMe: `bootloaderAddress = 0x1000`,
`esploader.after('hard_reset')` para el reset post-flasheo, requiere el paso manual
de "mantén BOOT presionado" (`waitingForBoot`) hasta confirmar en hardware real si el
circuito de auto-reset (más elaborado que el de PlayIoT, con flip-flop) permite
saltárselo.

Binarios esperados en el servidor (mismo hosting que PlayMe/PlayIoT):

```
https://playcode.tdrobotica.co/firmware/playgo/bootloader.bin
https://playcode.tdrobotica.co/firmware/playgo/partitions.bin
https://playcode.tdrobotica.co/firmware/playgo/firmware.bin
https://playcode.tdrobotica.co/firmware/playgo/version.txt
```
