# Firmware Binarios para ESP32

Este directorio contiene los binarios pre-compilados del firmware Arduino para el ESP32.

## Archivos requeridos:

- `bootloader.bin` - Bootloader del ESP32
- `partitions.bin` - Tabla de particiones
- `firmware.bin` - Firmware principal de PlayIoT

## Cómo generar los binarios:

### Opción 1: Desde Arduino IDE

1. Abre tu sketch de PlayIoT en Arduino IDE
2. Selecciona tu placa ESP32
3. Ve a **Sketch → Export Compiled Binary**
4. Los archivos .bin se generarán en la carpeta del sketch

### Opción 2: Desde Arduino CLI

```bash
# Compilar el sketch
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir ./build tu_sketch/

# Los binarios estarán en ./build/
# Copiar aquí:
cp ./build/tu_sketch.ino.bootloader.bin ./bootloader.bin
cp ./build/tu_sketch.ino.partitions.bin ./partitions.bin
cp ./build/tu_sketch.ino.bin ./firmware.bin
```

## Direcciones de Flash:

Los binarios se flashean en estas direcciones de memoria:

- `0x1000` - bootloader.bin
- `0x8000` - partitions.bin
- `0x10000` - firmware.bin

## Versión del Firmware:

El firmware debe responder al comando handshake:

```json
{"command": "getVersion"}
```

Con la respuesta:

```json
{"version": "1.0.0", "device": "PlayIoT-ESP32"}
```

## Notas:

- Los binarios deben ser para ESP32 (no ESP8266 ni otras variantes)
- Asegúrate de usar la configuración correcta de particiones
- El firmware debe implementar el protocolo serial JSON de PlayIoT
