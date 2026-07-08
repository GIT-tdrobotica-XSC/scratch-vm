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

| Subcomando | Campos | Descripción |
|---|---|---|
| `setMotorSpeed` | `left:Number(-100..100)`, `right:Number(-100..100)` | Velocidad directa de cada rueda, lazo abierto (sin encoder). Negativo = reversa. |
| `stopMotors` | — | Detiene ambos motores inmediatamente. |
| `moveDistance` | `moveId:Int`, `distanceCm:Number`, `speed:Number(-100..100)`, `wheelDiameterCm:Number`, `pulsesPerRev:Int` | Avanza en línea recta la distancia indicada, usando el encoder como lazo cerrado. El firmware calcula los pulsos objetivo con `distanceCm / (π * wheelDiameterCm) * pulsesPerRev`. |
| `turnAngle` | `moveId:Int`, `angleDeg:Number`, `speed:Number(-100..100)`, `wheelDiameterCm:Number`, `trackWidthCm:Number`, `pulsesPerRev:Int` | Gira el robot en su propio eje el ángulo indicado (positivo = sentido horario). Diferencial: cada rueda gira en sentido opuesto una distancia de arco `angleDeg/360 * π * trackWidthCm`. |
| `turnWheelRevs` | `moveId:Int`, `wheel:'left'|'right'|'both'`, `revolutions:Number`, `speed:Number(-100..100)`, `pulsesPerRev:Int` | Gira la(s) rueda(s) indicada(s) el número de vueltas exacto (control directo por encoder, sin conversión a distancia). |
| `resetEncoders` | — | Pone en 0 los contadores acumulados `encoderLeft`/`encoderRight` de la telemetría. |
| `servoWrite` | `pin:Int(11,12,13,14)`, `angle:Int(0-180)` | Mueve el servo conectado en el puerto especial A/B/C/D (= GPIO 11/12/13/14 respectivamente, serigrafía de la placa). Mismo GPIO que `digitalWrite` de playBlocks/play+ — el firmware decide el modo según cuál de los dos comandos reciba para ese pin. |

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

### Pantalla OLED (SH1107 128x128, I2C)

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

### Audio

| Subcomando | Campos | Descripción |
|---|---|---|
| `tone` | `freq:Number(Hz)`, `durationMs:Number` | Reproduce un tono simple por el I2S de salida. No bloqueante del lado firmware (debe poder recibir otros comandos mientras suena). |
| `toneStop` | — | Corta el tono en curso. |

No hay comando de streaming de audio — el protocolo no lo soporta (JSON por línea,
no binario). El micrófono solo reporta un nivel agregado (ver telemetría).

### Entradas/Salidas playBlocks y play+

Los módulos playBlocks y play+ comparten los mismos 4 conectores de entrada (IO1-IO4,
serigrafía "1","2","3","4") y 4 conectores de salida (IO11-IO14, serigrafía "A","B","C","D")
— el conector/módulo físico cambia, no el pin.

| Subcomando | Campos | Descripción |
|---|---|---|
| `digitalWrite` | `gpio:Int(11,12,13,14)`, `value:0|1` | Escribe una salida playBlocks/play+ (IO11-IO14 / A-D). |
| `setIOMode` | `mode:'playBlocks'\|'play+'` | Configura el módulo de extras conectado. Ver sección "Modo IO (GPIO 33)" más abajo — **requiere cuidado especial de implementación**. |

Las entradas (IO1-IO4) **no** tienen comando de escritura — se leen pasivamente vía
telemetría, en dos formas simultáneas (el firmware reporta ambas del mismo pin físico,
el bloque de Scratch usado decide cuál interpretación aplica):
- `inputs.gpio1..4` (0/1): lectura digital, para botones/sensores digitales conectados ahí.
- `inputs.pot1..4` (0-4095, ADC de 12 bits): lectura analógica, para el potenciómetro.

### Modo IO (GPIO 33) — ⚠️ requiere diseño cuidadoso de firmware

Según el diagrama "Funcionamiento playGo!" compartido por el usuario:
- **GPIO 33 = selector de modo**: LOW = módulo playBlocks conectado, HIGH = módulo play+ conectado.
- En modo **playBlocks**: IO1-4 son SIEMPRE entrada, IO11-14 (A-D) son SIEMPRE salida (fijo,
  es lo que ya implementan `readDigitalPB`/`analogReadPB`/`writeDigitalPB`/`servoWrite`).
- En modo **play+**: cada puerto (1-4 y A-D) debería poder configurarse individualmente
  como entrada O salida — **pendiente de confirmar con el equipo de hardware/firmware
  si esto es realmente posible así**. Mientras no esté confirmado, el firmware debe
  comportarse igual que en modo playBlocks (entradas/salidas fijas) cuando reciba
  `mode:'play+'`.
- **Conflicto físico a resolver en firmware**: el mismo GPIO 33 es también la línea
  **SDA del I2C interno** (botones PCF8574 + pantalla OLED). No se puede tener el pin
  actuando como I2C activo Y ser reconfigurado en cualquier momento por software al
  mismo tiempo. El bloque `setIOMode` de Scratch SÍ necesita poder cambiar el modo en
  cualquier momento (no solo leerlo al arrancar), así que el firmware tiene que
  manejarlo con cuidado, por ejemplo: al recibir `setIOMode`, pausar brevemente el I2C
  (`Wire.end()`), reconfigurar GPIO 33 como salida digital para fijar el modo, y luego
  reiniciar el I2C (`Wire.begin()`) — verificando que los botones/pantalla sigan
  funcionando después del cambio. Esto necesita probarse en hardware real; no hay
  garantía de que funcione limpio sin pruebas.

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

- **GPIO 33 = selector de modo IO (playBlocks/play+), NO es un LED de inicio.**
  Corrección sobre una nota anterior de este documento (que decía "LED de inicio
  blink" según la reunión previa) — el diagrama "Funcionamiento playGo!" confirmado
  por el usuario aclara que es el pin de modo, y que ADEMÁS es la línea SDA del I2C
  interno (botones+pantalla). Ver sección "Modo IO (GPIO 33)" arriba para el detalle
  completo y la advertencia de diseño de firmware.
- **Botones vía PCF8574** (expansor I2C, dirección `0x20` con A0-A2 a GND según el
  esquemático): el firmware lee los 8 botones (B0-B7) por ese chip y los reporta ya
  traducidos como `button_0..7` en la telemetría — no cambia nada del protocolo
  GUI↔firmware descrito arriba, es un detalle interno.
- **Header I2C genérico** (GND/3.3V/SCL/SDA, aparte del bus interno de botones/OLED):
  pensado para conectar sensores externos (ultrasonido, sensor de línea) en una
  etapa futura. Sin bloques ni comandos definidos todavía — pendiente de ver qué
  módulos exactos se conectan ahí.
- **Motores: 2x DRV8833** (driver H-bridge dual, uno por rueda). Control estándar de
  ese chip: PWM en `xIN1` con `xIN2=LOW` = un sentido, PWM en `xIN2` con `xIN1=LOW` =
  el otro, ambos en LOW = coast (rueda libre), ambos en HIGH = brake.
- **Parlante: MAX98357A** (amplificador clase D vía I2S — pines SD/SCLK/LRCLK/DIN).
  El tono (`tone`/`toneStop`) se genera sintetizando una onda (seno) y sacándola por
  I2S estándar; el pin `SD` debe quedar habilitado para que el ampli no esté en
  shutdown.
- **Display: boost a 13V (MT3608)** para la tensión de panel del SH1107 — falta
  confirmar si ese boost lo habilita el firmware por GPIO antes de inicializar la
  pantalla, o si arranca solo/siempre encendido.

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
