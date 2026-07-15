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

**Importante (confirmado v1.6, fix de rendimiento):** todos los `oled*` de arriba
(excepto `oledDisplay`) **solo escriben en el framebuffer en RAM**, no tocan el
panel físico. `oledDisplay` es el único comando que hace el volcado real por I2C.
Antes (v1.1-v1.5) cada comando de dibujo hacía su propio `display.display()`
inmediato -- un volcado completo de 128x128px por I2C (decenas de ms) por CADA
figura. Como el firmware es de un solo hilo, mientras estaba ocupado mandando
esos bytes por I2C no leía el siguiente comando serial ni corría el tick de
movimiento -- eso se sentía como lag en motores/RGB al combinarlos con OLED.
**Cualquier secuencia de dibujo en Scratch ahora debe terminar con el bloque
"OLED actualizar pantalla" (`oledDisplay`) para que se vea el resultado** --
dibujar sin ese bloque al final ya no actualiza el panel físico.

### Audio

| Subcomando | Campos | Descripción |
|---|---|---|
| `tone` | `freq:Number(Hz)`, `durationMs:Number` | Reproduce un tono simple por el I2S de salida. No bloqueante del lado firmware (debe poder recibir otros comandos mientras suena). |
| `toneStop` | — | Corta el tono en curso. |

El bloque "Reproducir nota" (Do/Re/Mi/Fa/Sol/La/Si + octava) es puramente del lado GUI:
convierte nota+octava a Hz (temperamento igual, A4=440Hz) y envía el mismo subcomando
`tone` de arriba. El firmware no necesita saber nada de notas musicales.

No hay comando de streaming de audio — el protocolo no lo soporta (JSON por línea,
no binario). El micrófono solo reporta un nivel agregado (ver telemetría).

**Nota de firmware — bug de audio "frecuencias raras" confirmado y corregido:**
el MAX98357A, con el pin SD flotante (cableado típico del breakout, mezcla
`(L+R)/2`), necesita que el firmware envíe I2S en modo **estéreo** con la misma
muestra duplicada en ambos canales. Configurarlo como `I2S_CHANNEL_FMT_ONLY_LEFT`
(mono, un solo canal con datos) deja el canal derecho sin definir; el ampli
mezcla el tono real con esa basura y suena distorsionado/con tono incorrecto.
Fix: `I2S_CHANNEL_FMT_RIGHT_LEFT` + escribir cada muestra dos veces (L y R).

**Segundo bug de audio confirmado y corregido (v1.7)** — el anterior no era
suficiente: seguía sonando "a ruido, ninguna nota reconocible". Causa real:
`i2s_write()` se llamaba con timeout no bloqueante (`0`). `loop()` genera
muestras mucho más rápido de lo que se reproducen (~2.9ms por bloque de 128
muestras); cuando el buffer DMA se llena, un write no bloqueante se descarta
en silencio, pero el acumulador de fase de la onda (`tonePhase`) igual
avanzaba como si esas muestras se hubieran reproducido. Eso desincroniza la
fase del audio realmente emitido, sonando como ruido en vez de un tono limpio
— coherente con `freq` llegando correcto (verificado en el log TX) pero el
audio sonando mal de todas formas. Fix: `i2s_write()` con `portMAX_DELAY`
(bloqueante), igual patrón que ya usaba `silenceI2S()`.

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
