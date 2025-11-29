/**
 * PlayIoT ESP32 Auto-Flasher
 * Módulo para flashear automáticamente firmware en ESP32 desde el navegador
 */

import {ESPLoader, Transport} from 'esptool-js';

/**
 * Clase para manejar el flasheo automático del ESP32
 */
class PlayIoTFlasher {
    constructor () {
        this._isFlashing = false;
        this._flashProgress = 0;
        this._onProgressCallback = null;
        this._onCompleteCallback = null;
        this._onErrorCallback = null;
    }

    /**
     * Verifica si el ESP32 tiene el firmware correcto
     * @param {SerialPort} port - Puerto serial conectado
     * @returns {Promise<{hasValidFirmware: boolean, version: string|null}>}
     */
    async checkFirmware (port) {
        try {
            // Enviar comando de handshake
            const writer = port.writable.getWriter();
            const encoder = new TextEncoder();
            const handshakeCommand = JSON.stringify({command: 'getVersion'}) + '\n';

            await writer.write(encoder.encode(handshakeCommand));
            writer.releaseLock();

            // Esperar respuesta (timeout 3 segundos)
            const response = await this._waitForResponse(port, 3000);

            if (response && response.version) {
                return {
                    hasValidFirmware: true,
                    version: response.version,
                    device: response.device || 'ESP32'
                };
            }

            return {hasValidFirmware: false, version: null};
        } catch (error) {
            console.warn('Error verificando firmware:', error);
            return {hasValidFirmware: false, version: null};
        }
    }

    /**
     * Espera respuesta del ESP32
     * @param {SerialPort} port - Puerto serial
     * @param {number} timeout - Timeout en ms
     * @returns {Promise<Object|null>}
     */
    async _waitForResponse (port, timeout) {
        return new Promise((resolve) => {
            const reader = port.readable.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let timer = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                reader.releaseLock();
            };

            timer = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeout);

            const readLoop = async () => {
                try {
                    const {value, done} = await reader.read();
                    if (done) {
                        cleanup();
                        resolve(null);
                        return;
                    }

                    buffer += decoder.decode(value, {stream: true});
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                const data = JSON.parse(line);
                                if (data.version) {
                                    cleanup();
                                    resolve(data);
                                    return;
                                }
                            } catch (e) {
                                // Ignorar líneas que no son JSON
                            }
                        }
                    }

                    // Continuar leyendo
                    readLoop();
                } catch (error) {
                    cleanup();
                    resolve(null);
                }
            };

            readLoop();
        });
    }

    /**
     * Flashea el firmware en el ESP32
     * @param {SerialPort} port - Puerto serial del ESP32
     * @param {Object} options - Opciones de flasheo
     * @returns {Promise<boolean>}
     */
    async flashFirmware (port, options = {}) {
        if (this._isFlashing) {
            throw new Error('Ya hay un proceso de flasheo en curso');
        }

        this._isFlashing = true;
        this._flashProgress = 0;

        try {
            // Configuración por defecto
            const config = {
                baudRate: options.baudRate || 115200,
                flashBaudRate: options.flashBaudRate || 460800,
                ...options
            };

            // Crear transport para esptool
            const transport = new Transport(port);

            // Crear loader
            const esploader = new ESPLoader({
                transport,
                baudrate: config.baudRate,
                terminal: {
                    clean: () => {},
                    writeLine: (data) => console.log(data),
                    write: (data) => console.log(data)
                }
            });

            // Conectar al chip
            this._updateProgress(10, 'Conectando al ESP32...');
            const chip = await esploader.main();
            console.log(`Chip detectado: ${chip}`);

            // Cambiar baudrate para flasheo más rápido
            this._updateProgress(20, 'Configurando velocidad de flasheo...');
            await esploader.setBaudrate(config.baudRate, config.flashBaudRate);

            // Cargar binarios del firmware
            this._updateProgress(30, 'Cargando archivos de firmware...');
            const fileArray = await this._loadFirmwareFiles();

            if (fileArray.length === 0) {
                throw new Error('No se encontraron archivos de firmware. Por favor, coloca los binarios en src/extensions/playiot/firmware/');
            }

            // Flashear cada archivo
            this._updateProgress(40, 'Flasheando firmware...');
            await esploader.writeFlash({
                fileArray,
                flashSize: 'keep',
                flashMode: 'keep',
                flashFreq: 'keep',
                eraseAll: false,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    const progress = 40 + ((written / total) * 50);
                    this._updateProgress(
                        Math.round(progress),
                        `Flasheando archivo ${fileIndex + 1}/${fileArray.length}...`
                    );
                }
            });

            this._updateProgress(90, 'Reiniciando ESP32...');

            // Hard reset
            await transport.setDTR(false);
            await transport.setRTS(true);
            await new Promise(resolve => setTimeout(resolve, 100));
            await transport.setRTS(false);

            this._updateProgress(100, 'Flasheo completado');
            this._isFlashing = false;

            if (this._onCompleteCallback) {
                this._onCompleteCallback();
            }

            return true;

        } catch (error) {
            this._isFlashing = false;
            console.error('Error durante el flasheo:', error);

            if (this._onErrorCallback) {
                this._onErrorCallback(error);
            }

            throw error;
        }
    }

    /**
     * Carga los archivos binarios del firmware
     * @returns {Promise<Array>}
     */
    async _loadFirmwareFiles () {
        const files = [];

        // Definir archivos y sus direcciones de flash
        const firmwareConfig = [
            {name: 'bootloader.bin', address: 0x1000},
            {name: 'partitions.bin', address: 0x8000},
            {name: 'firmware.bin', address: 0x10000}
        ];

        for (const config of firmwareConfig) {
            try {
                // Cargar archivo binario
                const response = await fetch(`/static/playiot/firmware/${config.name}`);

                if (!response.ok) {
                    console.warn(`Archivo ${config.name} no encontrado`);
                    continue;
                }

                const data = await response.arrayBuffer();

                files.push({
                    data: new Uint8Array(data),
                    address: config.address
                });

                console.log(`Cargado ${config.name} (${data.byteLength} bytes) @ 0x${config.address.toString(16)}`);
            } catch (error) {
                console.warn(`Error cargando ${config.name}:`, error);
            }
        }

        return files;
    }

    /**
     * Actualiza el progreso del flasheo
     * @param {number} progress - Porcentaje (0-100)
     * @param {string} message - Mensaje de estado
     */
    _updateProgress (progress, message) {
        this._flashProgress = progress;
        console.log(`[${progress}%] ${message}`);

        if (this._onProgressCallback) {
            this._onProgressCallback(progress, message);
        }
    }

    /**
     * Establece callback para progreso
     * @param {Function} callback - Función callback(progress, message)
     */
    onProgress (callback) {
        this._onProgressCallback = callback;
    }

    /**
     * Establece callback para completado
     * @param {Function} callback - Función callback()
     */
    onComplete (callback) {
        this._onCompleteCallback = callback;
    }

    /**
     * Establece callback para errores
     * @param {Function} callback - Función callback(error)
     */
    onError (callback) {
        this._onErrorCallback = callback;
    }

    /**
     * Obtiene el progreso actual del flasheo
     * @returns {number} - Porcentaje (0-100)
     */
    getProgress () {
        return this._flashProgress;
    }

    /**
     * Verifica si está flasheando actualmente
     * @returns {boolean}
     */
    isFlashing () {
        return this._isFlashing;
    }
}

export default PlayIoTFlasher;
