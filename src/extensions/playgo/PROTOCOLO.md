# Protocolo serial PlayGo

Este documento especifica el protocolo de comunicación entre PlayCode (Scratch) y el
firmware de la placa PlayGo (ESP32-S3 MINI), para que el equipo de firmware lo
implemente. Es el **mismo formato** que ya usan PlayMe y PlayIoT en producción — se
replica intencionalmente para reutilizar el mismo enfoque probado.

## Transporte

- **Web Serial API** desde el navegador (`navigator.serial`), `baudRate: 115200`, sin
  control de flujo adicional.
- Reset al conectar: **ninguno**. El ESP32-S3 MINI expone USB-JTAG nativo (igual que
  PlayMe), así que no se necesita el pulso DTR/RTS que sí requiere el ESP32
  clásico+CH340 de PlayIoT.

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

Los módulos playBlocks y play+ comparten los mismos 4 GPIO de entrada (1-4) y 4 GPIO
de salida (11-14) — el conector/módulo físico cambia, no el pin.

| Subcomando | Campos | Descripción |
|---|---|---|
| `digitalWrite` | `gpio:Int(11,12,13,14)`, `value:0|1` | Escribe una salida playBlocks/play+. |

Las entradas (GPIO 1-4) **no** tienen comando de escritura — se leen pasivamente vía
telemetría (`inputs.gpio1..4`).

## Placa → GUI (telemetría)

```json
{
  "inputs": {
    "button_0": 0, "button_1": 0, "button_2": 0, "button_3": 0,
    "button_4": 0, "button_5": 0, "button_6": 0, "button_7": 0,
    "gpio1": 0, "gpio2": 0, "gpio3": 0, "gpio4": 0,
    "encoderLeft": 0, "encoderRight": 0,
    "moveId": 0, "moveDone": 1,
    "micLevel": 0
  },
  "version": "1.0.0"
}
```

| Campo | Tipo | Descripción |
|---|---|---|
| `button_0`..`button_7` | 0/1 | Lectura binaria de los 8 botones vía I2C (P0-P7). |
| `gpio1`..`gpio4` | 0/1 | Entradas digitales playBlocks/play+. |
| `encoderLeft`/`encoderRight` | Int | Conteo acumulado de pulsos IRQ de cada encoder. No se resetea solo — solo vía `resetEncoders`. |
| `moveId`/`moveDone` | Int / 0\|1 | Ver semántica arriba. |
| `micLevel` | Int (0-100 sugerido) | Nivel de sonido agregado del micrófono I2S (ej. RMS de una ventana de ~100ms, mapeado a 0-100). No hay streaming de audio real. |
| `version` | String | Versión de firmware (`x.y.z`), comparada contra `https://playcode.tdrobotica.co/firmware/playgo/version.txt` para detectar firmware desactualizado. |

El paquete de `inputs` debe enviarse periódicamente (igual que PlayMe/PlayIoT hoy, no
especificado un intervalo exacto en este documento — replicar el mismo período que ya
usan esas placas).

## ⚠️ Punto abierto para confirmar con firmware/hardware

La ficha de especificaciones de hardware que se usó para diseñar esta extensión
asigna **el GPIO 33 dos veces**: como `SDA` del bus I2C del OLED, y como
"Habilitador modo PlayBlock" (salida/alimentación). Uno de los dos datos de la ficha
es incorrecto — hay que confirmar con el equipo de hardware cuál es el GPIO real de
cada función antes de fijar el firmware. Este conflicto **no afecta** el protocolo ni
los bloques de Scratch descritos arriba (el "Habilitador modo PlayBlock" es control
interno del firmware, sin comando ni bloque expuesto).

## Actualización de firmware (esptool-js)

PlayGo se trata igual que PlayMe en `scratch-gui/src/components/sprite-selector/firmware-updater-modal.jsx`
(mismo chip ESP32-S3): `bootloaderAddress = 0x0000`, reset post-flasheo por pulso RTS
(no `hard_reset` de esptool-js), sin paso manual de "mantén BOOT presionado".

Binarios esperados en el servidor (mismo hosting que PlayMe/PlayIoT):

```
https://playcode.tdrobotica.co/firmware/playgo/bootloader.bin
https://playcode.tdrobotica.co/firmware/playgo/partitions.bin
https://playcode.tdrobotica.co/firmware/playgo/firmware.bin
https://playcode.tdrobotica.co/firmware/playgo/version.txt
```
