# 🔧 Auto-Configuración ESP32 - PlayIoT

Esta funcionalidad permite instalar automáticamente el firmware de PlayIoT en el ESP32 directamente desde el navegador cada vez que se conecta.

## 📋 Características

- ✅ **Detección automática de firmware** al conectar el ESP32
- ✅ **Flasheo desde el navegador** usando Web Serial API + esptool.js
- ✅ **Sin instalación adicional** - todo funciona en el navegador
- ✅ **Diálogo de confirmación** antes de flashear
- ✅ **Progreso en tiempo real** del proceso de flasheo
- ✅ **Reconexión automática** después de flashear

## 🚀 Cómo Funciona

### Flujo Automático

```
1. Usuario conecta ESP32 (botón naranja en Scratch)
   ↓
2. Se establece conexión serial
   ↓
3. Sistema envía comando: {"command": "getVersion"}
   ↓
4. ESP32 responde:
   ✅ {"version": "1.0.0"} → Firmware OK
   ❌ No responde → Necesita flasheo
   ↓
5. Si necesita flasheo:
   - Muestra diálogo de confirmación
   - Usuario acepta
   - Flashea automáticamente
   - Reconecta
   ↓
6. ✅ ESP32 listo para usar
```

### Archivos que se Flashean

El sistema flashea 3 archivos en el ESP32:

| Archivo | Dirección | Descripción |
|---------|-----------|-------------|
| `bootloader.bin` | 0x1000 | Bootloader del ESP32 |
| `partitions.bin` | 0x8000 | Tabla de particiones |
| `firmware.bin` | 0x10000 | Firmware principal PlayIoT |

## 📦 Preparación de Binarios

### Opción 1: Arduino IDE

1. Abre tu sketch PlayIoT en Arduino IDE
2. Configura la placa: **ESP32 Dev Module**
3. Ve a **Sketch → Export Compiled Binary**
4. Los archivos se generan en la carpeta del sketch:
   - `tu_sketch.ino.bootloader.bin` → renombrar a `bootloader.bin`
   - `tu_sketch.ino.partitions.bin` → renombrar a `partitions.bin`
   - `tu_sketch.ino.bin` → renombrar a `firmware.bin`

5. Copiar los 3 archivos a: `src/extensions/playiot/firmware/`

### Opción 2: Arduino CLI

```bash
# Instalar Arduino CLI si no lo tienes
# https://arduino.github.io/arduino-cli/

# Compilar el sketch
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --output-dir ./build \
  playiot_sketch/

# Copiar binarios
cp ./build/playiot_sketch.ino.bootloader.bin \
   ./src/extensions/playiot/firmware/bootloader.bin

cp ./build/playiot_sketch.ino.partitions.bin \
   ./src/extensions/playiot/firmware/partitions.bin

cp ./build/playiot_sketch.ino.bin \
   ./src/extensions/playiot/firmware/firmware.bin
```

## 🔨 Requisitos del Firmware Arduino

Para que la auto-detección funcione, tu sketch de Arduino **debe implementar el protocolo de handshake**:

```cpp
// En tu sketch de Arduino/ESP32

void setup() {
  Serial.begin(115200);
  // ... resto de tu setup
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');

    // Parsear JSON
    DynamicJsonDocument doc(256);
    deserializeJson(doc, command);

    String cmd = doc["command"];

    // Responder a getVersion
    if (cmd == "getVersion") {
      DynamicJsonDocument response(128);
      response["version"] = "1.0.0";
      response["device"] = "PlayIoT-ESP32";

      String output;
      serializeJson(response, output);
      Serial.println(output);
    }

    // ... resto de tus comandos
  }
}
```

### Respuesta Esperada

Cuando el sistema envía `{"command": "getVersion"}`, el ESP32 debe responder:

```json
{
  "version": "1.0.0",
  "device": "PlayIoT-ESP32"
}
```

## 🎯 Uso

### Modo Automático (Por Defecto)

La auto-configuración está **habilitada por defecto**. Simplemente:

1. Conecta el ESP32 vía USB
2. Presiona el botón naranja en Scratch
3. Selecciona el puerto
4. Si el firmware no está instalado, aparecerá un diálogo
5. Acepta para instalar automáticamente
6. Espera ~30 segundos
7. ¡Listo!

### Deshabilitar Auto-Configuración

Si prefieres flashear manualmente, puedes deshabilitar la función:

```javascript
// En blocks.js o desde la consola del navegador
peripheral.setAutoFlashEnabled(false);
```

## 🛠️ Build del Proyecto

Después de agregar los binarios:

```bash
# Instalar dependencias (incluye esptool-js)
npm install

# Build del proyecto
npm run build

# O modo desarrollo
npm start
```

Los binarios se copiarán automáticamente a `playground/static/playiot/firmware/` gracias a la configuración de webpack.

## 📊 Progreso de Flasheo

Durante el flasheo verás mensajes en consola:

```
[10%] Conectando al ESP32...
[20%] Configurando velocidad de flasheo...
[30%] Cargando archivos de firmware...
[40%] Flasheando firmware...
[65%] Flasheando archivo 2/3...
[90%] Reiniciando ESP32...
[100%] Flasheo completado
```

## ⚠️ Solución de Problemas

### "No se encontraron archivos de firmware"

- **Causa:** Los archivos .bin no están en `src/extensions/playiot/firmware/`
- **Solución:** Compila tu sketch y copia los binarios (ver sección Preparación)

### "Error durante flasheo"

- **Causa:** Puerto ocupado o ESP32 en modo boot incorrecto
- **Solución:**
  1. Desconecta y reconecta el ESP32
  2. Mantén presionado el botón BOOT al conectar
  3. Intenta nuevamente

### "Firmware no detectado después de flashear"

- **Causa:** El sketch no implementa el protocolo de handshake
- **Solución:** Agrega el código de respuesta a `getVersion` (ver sección Requisitos)

### Flasheo en bucle

- **Causa:** El ESP32 siempre responde incorrectamente a `getVersion`
- **Solución:** Verifica tu código Arduino, debe responder con JSON válido

## 🔐 Seguridad

- Los archivos binarios se sirven desde el mismo servidor (CORS seguro)
- Solo funciona con HTTPS o localhost (requisito de Web Serial API)
- El usuario debe autorizar explícitamente el puerto serial
- Se solicita confirmación antes de flashear

## 🏗️ Arquitectura Técnica

```
PlayIoTPeripheral (blocks.js)
  ├── Constructor
  │   └── Crea instancia de PlayIoTFlasher
  │
  ├── connect(peripheralId)
  │   ├── Conecta puerto serial
  │   ├── Llama _checkAndFlashFirmware()
  │   └── Emite PERIPHERAL_CONNECTED
  │
  └── _checkAndFlashFirmware(port)
      ├── flasher.checkFirmware(port)
      │   └── Envía {"command":"getVersion"}
      ├── Si no válido → Muestra diálogo
      ├── flasher.flashFirmware(port)
      │   ├── ESPLoader.connect()
      │   ├── Carga binarios desde /static/playiot/firmware/
      │   ├── writeFlash() para cada archivo
      │   └── Hard reset
      └── Reconecta automáticamente

PlayIoTFlasher (playiot-flasher.js)
  ├── checkFirmware(port)
  │   └── Envía handshake y espera respuesta
  │
  ├── flashFirmware(port, options)
  │   ├── Transport(port)
  │   ├── ESPLoader()
  │   ├── _loadFirmwareFiles()
  │   └── writeFlash()
  │
  └── Callbacks:
      ├── onProgress(progress, message)
      ├── onComplete()
      └── onError(error)
```

## 📚 Referencias

- **esptool.js:** https://github.com/espressif/esptool-js
- **Web Serial API:** https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- **ESP32 Flash:** https://docs.espressif.com/projects/esptool/en/latest/

## 🤝 Contribuciones

Para mejorar esta funcionalidad:

1. Modifica `playiot-flasher.js` para la lógica de flasheo
2. Modifica `blocks.js` para la integración con Scratch
3. Actualiza binarios en `firmware/` cuando actualices el sketch
4. Ejecuta `npm run build` para probar cambios

## 📝 Notas

- El flasheo toma aproximadamente 30 segundos
- Requiere navegador compatible con Web Serial API (Chrome 89+, Edge 89+)
- Los binarios deben ser para **ESP32** (no ESP8266, ESP32-S2, etc.)
- La velocidad de flasheo es 460800 baudios (configurable)

---

**Versión:** 1.0.0
**Última actualización:** 2025-11-29
