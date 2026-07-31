# Protocolo de subida de programas compilados

Cómo viaja un programa de bytecode desde PlayCode hasta la memoria persistente
de la placa. Va **sobre el protocolo JSON que ya existe**: mismo envoltorio
`{"command":"outputsQueue","testValue":[...]}`, mismo troceado por saltos de
línea, mismo transporte (USB o BLE). No hace falta nada nuevo en el enlace.

> **Especificación ejecutable:** `test/fixtures/fake-board.js` implementa este
> protocolo entero en JS, incluidos todos los rechazos. Quien escriba el lado
> C++ puede leerlo y contrastar caso por caso; `test/unit/compiler_uploader.js`
> lo ejercita de punta a punta.

---

## 1. Resumen del flujo

```
PlayCode                                  Placa
   |-- progBegin{size,crc,isa,board,chunks} -->|   valida y reserva
   |<------------- {prog:{ack:"begin",ok:1}} --|
   |                                           |
   |-- progChunk{seq,off,data} --------------->|   escribe en progBuf[off]
   |<--- {prog:{ack:"chunk",seq:N,ok:1}} ------|   (se repite por cada trozo)
   |                                           |
   |-- progEnd ------------------------------->|   verifica CRC y PERSISTE
   |<---- {prog:{ack:"end",ok:1,crc:N}} -------|
   |                                           |
   |-- progRun ------------------------------->|   arranca el intérprete
   |<---- {prog:{ack:"run",ok:1}} -------------|
```

---

## 2. Subcomandos

| Subcomando   | Campos                                | Respuesta |
|--------------|---------------------------------------|-----------|
| `progBegin`  | `size`, `crc`, `isa`, `board`, `chunks` | `{prog:{ack:"begin",ok:1}}` o `ok:0` con `err` |
| `progChunk`  | `seq`, `off`, `data` (base64)         | `{prog:{ack:"chunk",seq:N,ok:1}}` |
| `progEnd`    | —                                     | `{prog:{ack:"end",ok:1,crc:N}}` |
| `progRun`    | —                                     | `{prog:{ack:"run",ok:1}}` |
| `progStop`   | —                                     | `{prog:{ack:"stop",ok:1}}` |
| `progErase`  | —                                     | `{prog:{ack:"erase",ok:1}}` |
| `progInfo`   | —                                     | `{prog:{ack:"info",ok:1,st,sz,crc,err}}` |

### Causas de rechazo (`err`)

| `err`      | Cuándo | Qué muestra PlayCode |
|------------|--------|----------------------|
| `isa`      | `isa` recibida ≠ `PC_ISA_VERSION` del firmware | "Tu robot necesita actualizar su firmware" |
| `board`    | `board` ≠ id de esta placa | "Este programa fue hecho para otro tipo de placa" |
| `size`     | `size` > 4096 | "El programa es demasiado grande" |
| `range`    | `off + len` se sale del programa | (error interno) |
| `toobig`   | El trozo supera el buffer | "Un trozo era demasiado grande" |
| `nobegin`  | Llegó un `progChunk`/`progEnd` sin `progBegin` | (error interno) |
| `crc`      | El CRC de lo recibido no cuadra | "El programa llegó dañado. Vuelve a intentarlo" |

**Con `err:"isa"` hay que devolver también `want` y `got`**, para poder decirle
al usuario qué versión necesita.

---

## 3. Decisiones y por qué

### `off` explícito en cada trozo

Cada `progChunk` lleva **su propio desplazamiento**, en vez de que el firmware
lo deduzca de `seq`. Deducirlo obligaría a que ambos lados coincidieran en el
tamaño de trozo, y **el último trozo casi nunca lo llena** — un `seq × tamaño`
mal calculado corrompe el programa de forma silenciosa.

Con el desplazamiento explícito el firmware queda **sin estado**: recibe, valida
el rango, escribe. Reintentos y llegadas desordenadas son correctos por
construcción.

> Este fallo lo encontró un test antes de existir una sola línea de C++.

### Ack por trozo, no streaming

El firmware drena `Serial.available()` **una vez por vuelta de `loop()`**, y esa
vuelta puede tardar más de 100 ms cuando el OLED vuelca. Una ráfaga desbordaría
la FIFO de 256 bytes y se perderían trozos **en silencio**.

Con ack por trozo, 3 KB por USB tardan ~400 ms. Es un precio bajo por no tener
que depurar programas que llegan a medias.

### Tamaño de trozo por transporte

| Transporte | Bytes/trozo | Línea resultante |
|------------|-------------|------------------|
| USB        | 384         | ~590 caracteres |
| **BLE**    | **128**     | ~250 caracteres |

Por BLE, la GUI trocea cada escritura en paquetes de 20 bytes: una línea de 590
caracteres son ~30 escrituras GATT seguidas, **exactamente** el patrón de
congestión detrás de las desconexiones de PROTOCOLO.md (v2.0.4, v2.0.8, v2.1.3).

**Recomendar USB para subir.** No hace falta bloquear BLE, pero sí sugerir el
cable.

### Base64

El transporte pasa por `TextEncoderStream` y el troceado del protocolo es por
`\n`: bytes arbitrarios romperían las dos cosas.

### Persistencia: NVS, no LittleFS

La partición NVS **ya existe** en la tabla por defecto → cero cambios en
`partitions.bin`, y por tanto **cero riesgo de tener que reflashear la tabla de
particiones de placas ya repartidas en colegios**. Tope de 4096 bytes por blob
(unas 2000 instrucciones, muy por encima de cualquier programa infantil).

Claves en el namespace `playcode`: `pc_prog` (blob), `pc_crc` (u16), `pc_auto` (u8).

---

## 4. Cambios necesarios en el firmware

### 4.1 Subir dos límites (⚠️ imprescindible)

```cpp
// handleLine() -- main.cpp:833
StaticJsonDocument<1024> doc;   // era 512

// loop() -- main.cpp:1177
if (serialBuffer.length() > 2048) serialBuffer = "";   // era 1024
```

Sin esto, **las líneas de `progChunk` se descartan sin decir nada** y la subida
se queda colgada sin explicación posible.

### 4.2 Buffers

```cpp
static uint8_t progBuf[8192];   // recepción en RAM (de 512 KB disponibles)
#define PROG_MAX_PERSISTED 4096 // tope de lo que se guarda en NVS
```

Se persiste **sólo tras verificar el CRC**: es preferible quedarse sin programa
que guardar uno roto que luego mueva motores de forma impredecible.

### 4.3 CRC16-CCITT

Polinomio `0x1021`, inicial `0xFFFF`, sin reflejar. Debe dar **exactamente** lo
mismo que `src/compiler/crc16.js`.

Vector de prueba: `"123456789"` → `0x29B1`.

### 4.4 Telemetría

Añadir dos campos al nivel de `inputs` (no dentro):

```json
{"inputs":{…}, "version":"2.2.0", "isa":1,
 "prog":{"st":"running","sz":247,"crc":48291,"err":0}}
```

`st` ∈ `empty | loaded | running | error`.

Nombres cortos a propósito: la telemetría ya pesa ~400 bytes y el equilibrio de
MTU en BLE es frágil. Sumar ~50 bytes es aceptable; sumar 150 no.

### 4.5 Arranque solo

En `setup()`, tras el hardware y **antes** de `bleInit()`:

1. Cargar de NVS.
2. Validar magic, CRC y que `isa` de la cabecera == `PC_ISA_VERSION`.
3. Si `pc_auto` está puesto → `vmStart()`.
4. Pulso verde de 1 s en el LED RGB 0 como señal visible de "arranqué solo".

> **Escotilla de escape obligatoria:** mantener **B0 pulsado 2 segundos al
> encender salta el autoarranque**. Sin esto, un programa que lanza los motores
> contra una pared sólo se arregla reflasheando la placa. Es barato y va a
> salvar a alguien.

### 4.6 Guarda de modos

Al principio de `processSubcommand()`, cuatro líneas:

```cpp
if (vmRunning && !isProgCommand(command) && command != "ping") {
    // Máximo un aviso por segundo, para no inundar el enlace.
    if (millis() - lastBusyWarnMs > 1000) {
        lastBusyWarnMs = millis();
        sendLine("{\"prog\":{\"warn\":\"busy\"}}");
    }
    return;
}
```

Ésa es **toda** la regla de "los dos modos no se pelean por el hardware".

---

## 5. Qué NO debe hacer el firmware

- **No detener el VM al desconectarse el enlace.** Que el robot siga andando
  con el cable fuera es literalmente el objetivo de esta función.
- **No borrar el programa al actualizar el firmware.** NVS sobrevive; si la ISA
  nueva no coincide, se detecta al cargar y se pide resubir.
- **No limpiar el OLED en `progStop`.** Una pantalla en negro parece un cuelgue.

---

## 6. Estado de la implementación

| Pieza | Estado |
|-------|--------|
| Uploader JS (`extensions/common/program-uploader.js`) | ✅ hecho, con tests |
| Placa falsa + tests de punta a punta | ✅ hecho (56 asserts) |
| Enganche en el peripheral de PlayGo | ✅ hecho |
| `prog*` en el firmware C++ | ⛔ pendiente (F2 firmware) |
| NVS + arranque solo + escotilla B0 | ⛔ pendiente (F2 firmware) |
| Intérprete de bytecode en C++ | ⛔ pendiente (F3) |
