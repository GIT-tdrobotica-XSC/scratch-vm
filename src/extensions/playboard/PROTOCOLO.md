# Protocolo PlayBoard + PlayShield V2 (Arduino UNO / ATmega328p)

Especificación del protocolo serial entre PlayCode (navegador) y la placa.
Mismo formato JSON-por-línea que los demás dispositivos, pero adaptado a las
limitaciones del ATmega328p (2 KB de SRAM, 32 KB de flash).

---

## Hardware

| MCU | ATmega328p (Arduino UNO) — puente USB-serial (16U2 o CH340) |
|---|---|
| Conexión | **Solo USB** (Web Serial). No hay inalámbrico. |
| Baudios | **115200** |
| Reset | Al abrir el puerto, DTR resetea la placa; optiboot corre ~1s antes del sketch. La GUI espera ~1.2s tras conectar. |
| Flasheo | **Con Arduino IDE** (avrdude/STK500). PlayCode NO integra actualizador para este dispositivo. |

### Mapa de pines

| Pin(es) | Función |
|---|---|
| A0 | Potenciómetro |
| A1, A2, A3 | Entradas analógicas |
| A4, A5 | I2C → **pantalla OLED** (SSD1306, dir. típica 0x3C) |
| D2, D4, D7, D8, D9, D10 | Entrada/Salida digital |
| D6, D5 | Driver Motor **M1** (H-puente, doble PWM) |
| D11, D3 | Driver Motor **M2** (H-puente, doble PWM) |
| D12, D13 | Botones 1 y 2 |

> **Nota SRAM:** el framebuffer del SSD1306 128×64 ocupa ~1 KB (la mitad de la
> SRAM del UNO). Mantén los buffers de ArduinoJson pequeños (`StaticJsonDocument
> <200>` basta para estos comandos) y usa `F("...")` para las cadenas literales.

---

## Framing

- Un mensaje **JSON por línea**, terminado en `\n`. Sin checksum.
- **GUI → placa:** `{"command":"outputsQueue","testValue":[ { …subcomando… } ]}`
- **placa → GUI (telemetría):** `{"inputs":{ … },"version":"…"}` — enviar de
  forma periódica (p. ej. cada 100 ms).

La GUI deduplica los comandos repetidos (motor, salida digital), así que la
placa recibe un comando solo cuando el valor cambia. Aun así, el firmware debe
tolerar recibir el mismo comando varias veces.

---

## Comandos GUI → placa (dentro de `testValue`)

### Motores
Cada motor es un H-puente de doble PWM. `speed` va de -100 a 100:
- `speed > 0`: `analogWrite(pinA, map(speed,0,100,0,255)); analogWrite(pinB, 0);`
- `speed < 0`: `analogWrite(pinA, 0); analogWrite(pinB, map(-speed,0,100,0,255));`
- `speed == 0`: ambos pines a 0.

M1 = (D6, D5), M2 = (D11, D3) — confirmado contra la serigrafía real de la
placa (rótulos "M1"/"M2" junto al chip driver + LEDs indicadoras D6/D5/D11/D3
en ese orden). Los cuatro son pines PWM del UNO.

| Comando | Campos | Efecto |
|---|---|---|
| `setMotors` | `m1` (-100..100), `m2` (-100..100) | Fija ambos motores |
| `setMotor` | `motor` (1 o 2), `speed` (-100..100) | Fija un motor |
| `stopMotors` | — | Ambos motores a 0 |

```json
{"command":"outputsQueue","testValue":[{"command":"setMotors","m1":50,"m2":-30}]}
{"command":"outputsQueue","testValue":[{"command":"setMotor","motor":1,"speed":80}]}
{"command":"outputsQueue","testValue":[{"command":"stopMotors"}]}
```

### Salida digital
| Comando | Campos | Efecto |
|---|---|---|
| `digitalWrite` | `pin` (2,4,7,8,9,10), `value` (0/1) | `pinMode(pin,OUTPUT); digitalWrite(pin,value)` |

```json
{"command":"outputsQueue","testValue":[{"command":"digitalWrite","pin":8,"value":1}]}
```

> Un pin usado como salida deja de tener sentido como entrada: mientras esté en
> OUTPUT, el firmware puede reportar en la telemetría el último valor escrito (o
> simplemente su `digitalRead`). No mezclar el mismo pin como entrada y salida
> en el mismo programa.

### Pantalla OLED (SSD1306 por I2C en A4/A5)
Coordenadas en píxeles (128×64). `size` = escala de texto (1, 2, 3).

| Comando | Campos |
|---|---|
| `oledText` | `text`, `size` — texto desde arriba-izquierda |
| `oledNumber` | `line` (0..3), `label` (texto), `value` (número) — “label: value” en esa línea |
| `oledLine` | `line` (0..3), `text` |
| `oledTextXY` | `text`, `x`, `y`, `size` |
| `oledClear` | — (borra el buffer) |
| `oledDrawLine` | `x0`, `y0`, `x1`, `y1` |
| `oledDrawRect` | `x`, `y`, `w`, `h` (contorno) |
| `oledFillRect` | `x`, `y`, `w`, `h` (relleno) |
| `oledDrawCircle` | `x`, `y`, `r` |
| `oledDrawPixel` | `x`, `y` |
| `oledDisplay` | — (vuelca el buffer a la pantalla) |

```json
{"command":"outputsQueue","testValue":[{"command":"oledLine","line":0,"text":"Hola"}]}
{"command":"outputsQueue","testValue":[{"command":"oledDisplay"}]}
```

> **Recomendado:** hacer auto-flush (llamar `display.display()` internamente)
> tras cada comando `oled*`, para que dibujar funcione sin necesidad de un
> `oledDisplay` explícito. (En PlayGo se limitó el auto-flush a ~10 Hz para no
> frenar otros periféricos; en el UNO no hay tantos periféricos concurrentes,
> pero conviene no llamar `display()` más rápido de lo necesario.)

---

## Telemetría placa → GUI

Enviar periódicamente (≈100 ms). Todas las entradas son de **solo lectura**:

```json
{"inputs":{"pot":512,"a1":0,"a2":0,"a3":0,"d2":0,"d4":0,"d7":0,"d8":0,"d9":0,"d10":0,"btn1":0,"btn2":0},"version":"1.0"}
```

| Clave | Origen | Rango |
|---|---|---|
| `pot` | A0 (`analogRead`) | 0–1023 |
| `a1`, `a2`, `a3` | A1–A3 (`analogRead`) | 0–1023 |
| `d2,d4,d7,d8,d9,d10` | D2..D10 (`digitalRead`, INPUT_PULLUP) | 0/1 |
| `btn1`, `btn2` | D12, D13 (`digitalRead`, INPUT_PULLUP) | 0/1 |
| `version` | versión del firmware (string) | — |

> **Confirmado en hardware real:** en esta placa los botones D12/D13 leen
> **HIGH cuando están presionados** (al revés de lo esperado con
> `INPUT_PULLUP` + botón-a-GND). El firmware invierte la lectura antes de
> reportar (`btn1`/`btn2` = 1 cuando el botón está presionado), para que el
> bloque "Botón presionado?" funcione de forma intuitiva, igual que en los
> demás dispositivos.

---

## Notas de implementación (firmware Arduino)

- Buffer de recepción por líneas: acumular caracteres hasta `\n`, parsear con
  `ArduinoJson` (StaticJsonDocument pequeño), ejecutar cada objeto de
  `testValue`.
- No bloquear en el loop: la telemetría cada ~100 ms y la lectura serial deben
  convivir; usar `millis()` en vez de `delay()` para el periodo de telemetría.
- El sketch de referencia está en `firmware/PlayBoard/PlayBoard.ino` (dentro
  de esta misma carpeta de extensión), listo para abrir en Arduino IDE.
  Requiere las bibliotecas: **ArduinoJson** (v6), **Adafruit SSD1306** y
  **Adafruit GFX Library**.
