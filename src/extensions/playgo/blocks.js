const BlockType = require('../../extension-support/block-type');
const ArgumentType = require('../../extension-support/argument-type');
const PlayGoSerial = require('./playgo-serial');

class PlayGoPeripheral {
    constructor(runtime, extensionId) {

        this._runtime = runtime;
        this._extensionId = extensionId;
        this._serial = new PlayGoSerial();
        this.devices = [];
        this._scanning = false;
        this._connectedDeviceId = null;
        this.buffer = '';

        this.sensorData = {
            button_0: 0, button_1: 0, button_2: 0, button_3: 0,
            button_4: 0, button_5: 0, button_6: 0, button_7: 0,
            gpio1: 0, gpio2: 0, gpio3: 0, gpio4: 0,
            pot1: 0, pot2: 0, pot3: 0, pot4: 0,
            encoderLeft: 0, encoderRight: 0,
            moveId: 0, moveDone: 1,
            micLevel: 0
        };

        // Variables para validar versión de firmware
        this.deviceFirmwareVersion = null;
        this.serverFirmwareVersion = null;
        this._firmwareVersionFetched = false;

        // Contador de movimientos (avanzar/girar) para el mecanismo de espera
        // asíncrona: cada comando de movimiento lleva un moveId propio, y el
        // bloque de Scratch espera a que sensorData.moveId/moveDone lo confirmen.
        this._moveCounter = 0;

        this._runtime.registerPeripheralExtension(extensionId, this);
        this._autoScan();
        window.playGoSerial = this._serial;
        window.playGoPeripheral = this;
    }

    async _autoScan() {
        // No pre-poblar con puertos históricos del browser para evitar acumulación
        // entre sesiones. El usuario selecciona el puerto manualmente con scan().
        try {
            if ('serial' in navigator) {
                const ports = await navigator.serial.getPorts();
                // Olvidar todos los puertos acumulados de sesiones anteriores
                for (const port of ports) {
                    try { await port.forget(); } catch (e) { /* ignorar */ }
                }
                console.log('Auto-scan: limpiados', ports.length, 'puertos históricos');
            }
        } catch (e) {
            console.warn('Error en auto-scan:', e);
        }
    }

    async scan() {
        if (this._scanning) {
            console.log('Escaneo ya en progreso');
            return;
        }

        this._scanning = true;
        console.log('Solicitando nuevo puerto...');

        try {
            const newPort = await navigator.serial.requestPort();

            // Siempre reemplazar la lista con el puerto recién seleccionado.
            // Usar push+includes causaba race conditions: forget() en disconnect()
            // hacía que requestPort() retornara un objeto nuevo en el siguiente scan,
            // que no coincidía por referencia con el anterior → duplicado.
            this.devices = [newPort];

            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this.getPeripheralDeviceList()
            );
        } catch (e) {
            if (e.name === 'NotFoundError') {
                console.log('Usuario canceló');
            } else {
                console.error('Error en scan:', e);
            }
        } finally {
            this._scanning = false;
        }
    }

    getPeripheralDeviceList() {
        return this.devices.map((port, index) => {
            const deviceId = `playgo_${index}`;
            return {
                id: deviceId,
                peripheralId: deviceId,
                name: this.getPeripheralName(deviceId),
                rssi: -50,
                connected: this._connectedDeviceId === deviceId
            };
        });
    }

    async connect(peripheralId) {
        console.log('Intentando conectar a:', peripheralId);

        const index = parseInt(peripheralId.split('_')[1]);
        const port = this.devices[index];

        if (!port) {
            console.error('Puerto no encontrado para', peripheralId);
            return;
        }

        try {
            await this._serial.connect(port);
            this._connectedDeviceId = peripheralId;

            this._setupDataHandler();

            this._serial.onDisconnect = () => {
                console.log('Desconexión inesperada detectada');
                this._connectedDeviceId = null;
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
            };

            console.log('Conectado exitosamente a', peripheralId);

            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
        } catch (e) {
            console.error('Error conectando:', e);
            this._connectedDeviceId = null;
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                message: `Error: ${e.message}`,
                extensionId: this._extensionId
            });
        }
    }

    _setupDataHandler() {
        if (!this._serial) return;

        this._serial.onData = (data) => {
            if (data.inputs) {
                Object.keys(data.inputs).forEach(key => {
                    this.sensorData[key] = data.inputs[key];
                });
            }
            // Detectar versión del dispositivo
            if (data.version && data.version !== this.deviceFirmwareVersion) {
                this.deviceFirmwareVersion = data.version;
                console.log('PlayGo Firmware detectado:', data.version);
            }
        };

        // Obtener versión del servidor una sola vez por conexión
        if (!this._firmwareVersionFetched) {
            this._firmwareVersionFetched = true;
            fetch(`https://playcode.tdrobotica.co/firmware/${this._extensionId}/version.txt`)
                .then(r => r.ok ? r.text() : null)
                .then(v => {
                    if (v) this.serverFirmwareVersion = v.trim();
                    console.log('PlayGo Firmware servidor:', this.serverFirmwareVersion);
                })
                .catch(() => {});
        }

        console.log('Handler de datos configurado');
    }

    getFirmwareStatus() {
        if (!this.serverFirmwareVersion) return 'unknown';
        if (!this.deviceFirmwareVersion) return 'unknown';
        return this.deviceFirmwareVersion === this.serverFirmwareVersion ? 'updated' : 'outdated';
    }

    async disconnect() {
        console.log('Desconectando dispositivo...');

        try {
            this.buffer = '';

            Object.keys(this.sensorData).forEach(key => {
                this.sensorData[key] = 0;
            });
            this.sensorData.moveDone = 1;

            if (this._serial) {
                await this._serial.disconnect();
            }

            this._connectedDeviceId = null;

            // Limpiar la lista. No llamar port.forget() aquí: causaba race condition
            // donde el siguiente scan obtenía un objeto nuevo del mismo puerto
            // (porque fue olvidado) y el dedup por referencia fallaba → duplicados.
            // _autoScan() limpia puertos históricos al arrancar la app.
            this.devices = [];

            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this.getPeripheralDeviceList()
            );
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);

        } catch (error) {
            console.error('Error durante desconexión:', error);

            this.buffer = '';
            this._connectedDeviceId = null;
            this.devices = [];

            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this.getPeripheralDeviceList()
            );
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    isConnected() {
        return this._serial && this._serial.connected;
    }

    getPeripheralDeviceIds() {
        return this.devices.map((_, i) => `playgo_${i}`);
    }

    /**
     * 🔐 Reconecta el periférico después de un flasheo de firmware.
     */
    async reconnect(port) {
        if (!this._serial || !port) return;
        try {
            await this._serial.claimPort(port);
            this._connectedDeviceId = this._connectedDeviceId || 'playgo_0';
            this._setupDataHandler();
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
            console.log('✅ PlayGo re-inicializado correctamente.');
        } catch (e) {
            console.error('❌ Error re-inicializando PlayGo:', e);
        }
    }

    getSerialPort() {
        return this._serial ? this._serial.port : null;
    }

    getPeripheralName(deviceId) {
        const index = parseInt(deviceId.split('_')[1]);
        return `PlayGo Device #${index + 1}`;
    }

    // ── Movimiento asíncrono (avanzar/girar por encoder) ─────────────────────
    // El protocolo (JSON por línea) no tiene forma nativa de "bloquear hasta
    // terminar", así que cada comando de movimiento lleva un moveId propio.
    // El firmware debe reportar moveId/moveDone:1 en la telemetría cuando el
    // movimiento termina (y mantenerlo en 1 hasta el siguiente movimiento).
    _nextMoveId() {
        this._moveCounter = (this._moveCounter || 0) + 1;
        return this._moveCounter;
    }

    _waitForMoveComplete(moveId, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (!this.isConnected()) {
                    resolve();
                    return;
                }
                if (this.sensorData.moveId === moveId && this.sensorData.moveDone === 1) {
                    resolve();
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    console.warn(`[PlayGo] Timeout esperando fin de movimiento ${moveId}`);
                    resolve();
                    return;
                }
                setTimeout(check, 50);
            };
            check();
        });
    }
}

class PlayGo {
    constructor(runtime, extensionId) {
        this.runtime = runtime;
        this.peripheral = new PlayGoPeripheral(runtime, extensionId);
    }

    getInfo() {
        return {
            id: 'playgo',
            name: 'PlayGo',
            color1: '#2ECC71',
            color2: '#27AE60',
            color3: '#1E8449',
            showStatusButton: true,
            blocks: [
                // ---- MOTORES ----
                {
                    opcode: 'setMotorSpeeds',
                    blockType: BlockType.COMMAND,
                    text: 'Motores  izquierdo:[LEFT]%  derecho:[RIGHT]%',
                    arguments: {
                        LEFT: { type: ArgumentType.NUMBER, defaultValue: 50 },
                        RIGHT: { type: ArgumentType.NUMBER, defaultValue: 50 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'stopMotors',
                    blockType: BlockType.COMMAND,
                    text: 'Detener motores',
                    category: 'Motores'
                },
                {
                    opcode: 'moveDistanceCm',
                    blockType: BlockType.COMMAND,
                    text: 'Avanzar [DISTANCE] cm a velocidad [SPEED]% (rueda Ø[WHEEL_DIAM]cm, pulsos/vuelta [PULSES_PER_REV])',
                    arguments: {
                        DISTANCE: { type: ArgumentType.NUMBER, defaultValue: 20 },
                        SPEED: { type: ArgumentType.NUMBER, defaultValue: 60 },
                        WHEEL_DIAM: { type: ArgumentType.NUMBER, defaultValue: 6.5 },
                        PULSES_PER_REV: { type: ArgumentType.NUMBER, defaultValue: 20 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'turnAngleDeg',
                    blockType: BlockType.COMMAND,
                    text: 'Girar [ANGLE]° a velocidad [SPEED]% (rueda Ø[WHEEL_DIAM]cm, vía [TRACK_WIDTH]cm, pulsos/vuelta [PULSES_PER_REV])',
                    arguments: {
                        ANGLE: { type: ArgumentType.NUMBER, defaultValue: 90 },
                        SPEED: { type: ArgumentType.NUMBER, defaultValue: 60 },
                        WHEEL_DIAM: { type: ArgumentType.NUMBER, defaultValue: 6.5 },
                        TRACK_WIDTH: { type: ArgumentType.NUMBER, defaultValue: 12 },
                        PULSES_PER_REV: { type: ArgumentType.NUMBER, defaultValue: 20 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'turnWheelRevolutions',
                    blockType: BlockType.COMMAND,
                    text: 'Girar rueda [WHEEL] [REVOLUTIONS] vueltas a velocidad [SPEED]% (pulsos/vuelta [PULSES_PER_REV])',
                    arguments: {
                        WHEEL: { type: ArgumentType.STRING, menu: 'wheelSide', defaultValue: 'both' },
                        REVOLUTIONS: { type: ArgumentType.NUMBER, defaultValue: 1 },
                        SPEED: { type: ArgumentType.NUMBER, defaultValue: 60 },
                        PULSES_PER_REV: { type: ArgumentType.NUMBER, defaultValue: 20 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'resetEncoders',
                    blockType: BlockType.COMMAND,
                    text: 'Reiniciar contadores de encoder',
                    category: 'Motores'
                },
                {
                    opcode: 'getEncoderPulses',
                    blockType: BlockType.REPORTER,
                    text: 'Pulsos encoder [WHEEL]',
                    arguments: {
                        WHEEL: { type: ArgumentType.STRING, menu: 'wheelSideSingle', defaultValue: 'left' }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'setServoPlayGo',
                    blockType: BlockType.COMMAND,
                    text: 'Servo [PORT] ángulo [ANGLE]°',
                    arguments: {
                        PORT: { type: ArgumentType.STRING, menu: 'servoPorts', defaultValue: 'A' },
                        ANGLE: { type: ArgumentType.NUMBER, defaultValue: 90 }
                    },
                    category: 'Motores'
                },

                // ---- BOTONES ----
                {
                    opcode: 'readButtonPlayGo',
                    blockType: BlockType.BOOLEAN,
                    text: 'Botón [BUTTON] presionado?',
                    arguments: {
                        BUTTON: { type: ArgumentType.STRING, menu: 'buttonsPlayGo', defaultValue: '0' }
                    },
                    category: 'Botones'
                },

                // ---- RGB ----
                {
                    opcode: 'setRGBColor',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] R:[R] G:[G] B:[B]',
                    arguments: {
                        LED: { type: ArgumentType.NUMBER, menu: 'rgbLeds', defaultValue: '0' },
                        R: { type: ArgumentType.NUMBER, defaultValue: 255 },
                        G: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        B: { type: ArgumentType.NUMBER, defaultValue: 0 }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'setRGBColorHex',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] color [COLOR]',
                    arguments: {
                        LED: { type: ArgumentType.NUMBER, menu: 'rgbLeds', defaultValue: '0' },
                        COLOR: { type: ArgumentType.COLOR, defaultValue: '#ff0000' }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'setRGBPreset',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] [PRESET]',
                    arguments: {
                        LED: { type: ArgumentType.NUMBER, menu: 'rgbLeds', defaultValue: '0' },
                        PRESET: { type: ArgumentType.STRING, menu: 'rgbPresets', defaultValue: 'red' }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'rgbOff',
                    blockType: BlockType.COMMAND,
                    text: 'Apagar LED RGB [LED]',
                    arguments: {
                        LED: { type: ArgumentType.NUMBER, menu: 'rgbLeds', defaultValue: '0' }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'allRGBOff',
                    blockType: BlockType.COMMAND,
                    text: 'Apagar todos los LEDs RGB',
                    category: 'RGB'
                },
                {
                    opcode: 'setAllRGB',
                    blockType: BlockType.COMMAND,
                    text: 'Todos los LEDs RGB color [COLOR]',
                    arguments: {
                        COLOR: { type: ArgumentType.COLOR, defaultValue: '#ff0000' }
                    },
                    category: 'RGB'
                },

                // ---- PANTALLA OLED ----
                {
                    opcode: 'oledText',
                    blockType: BlockType.COMMAND,
                    text: 'OLED mostrar texto [TEXT] tamaño [SIZE]',
                    arguments: {
                        TEXT: { type: ArgumentType.STRING, defaultValue: 'Hola' },
                        SIZE: { type: ArgumentType.NUMBER, menu: 'textSize', defaultValue: '1' }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledNumber',
                    blockType: BlockType.COMMAND,
                    text: 'OLED línea [LINE] mostrar [LABEL] valor [VALUE]',
                    arguments: {
                        LINE: { type: ArgumentType.NUMBER, menu: 'oledLines', defaultValue: '0' },
                        LABEL: { type: ArgumentType.STRING, defaultValue: 'Temp' },
                        VALUE: { type: ArgumentType.NUMBER, defaultValue: 25 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledClear',
                    blockType: BlockType.COMMAND,
                    text: 'OLED limpiar pantalla',
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledLine',
                    blockType: BlockType.COMMAND,
                    text: 'OLED línea [LINE] texto [TEXT]',
                    arguments: {
                        LINE: { type: ArgumentType.NUMBER, menu: 'oledLines', defaultValue: '0' },
                        TEXT: { type: ArgumentType.STRING, defaultValue: 'Línea' }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledTextXY',
                    blockType: BlockType.COMMAND,
                    text: 'OLED texto [TEXT] X:[X] Y:[Y] tamaño [SIZE]',
                    arguments: {
                        TEXT: { type: ArgumentType.STRING, defaultValue: 'Hola' },
                        X: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        SIZE: { type: ArgumentType.NUMBER, menu: 'textSize', defaultValue: '1' }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledEmoji',
                    blockType: BlockType.COMMAND,
                    text: 'OLED emoticón [EMOJI] X:[X] Y:[Y]',
                    arguments: {
                        EMOJI: { type: ArgumentType.STRING, menu: 'emojiList', defaultValue: 'smile' },
                        X: { type: ArgumentType.NUMBER, defaultValue: 48 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 16 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledDrawLine',
                    blockType: BlockType.COMMAND,
                    text: 'OLED línea X0:[X0] Y0:[Y0] X1:[X1] Y1:[Y1]',
                    arguments: {
                        X0: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        Y0: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        X1: { type: ArgumentType.NUMBER, defaultValue: 64 },
                        Y1: { type: ArgumentType.NUMBER, defaultValue: 32 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledDrawRect',
                    blockType: BlockType.COMMAND,
                    text: 'OLED rectángulo X:[X] Y:[Y] ancho:[W] alto:[H]',
                    arguments: {
                        X: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        W: { type: ArgumentType.NUMBER, defaultValue: 60 },
                        H: { type: ArgumentType.NUMBER, defaultValue: 30 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledFillRect',
                    blockType: BlockType.COMMAND,
                    text: 'OLED rectángulo relleno X:[X] Y:[Y] ancho:[W] alto:[H]',
                    arguments: {
                        X: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        W: { type: ArgumentType.NUMBER, defaultValue: 60 },
                        H: { type: ArgumentType.NUMBER, defaultValue: 30 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledDrawCircle',
                    blockType: BlockType.COMMAND,
                    text: 'OLED círculo X:[X] Y:[Y] radio:[R]',
                    arguments: {
                        X: { type: ArgumentType.NUMBER, defaultValue: 64 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 32 },
                        R: { type: ArgumentType.NUMBER, defaultValue: 16 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledDrawPixel',
                    blockType: BlockType.COMMAND,
                    text: 'OLED pixel X:[X] Y:[Y]',
                    arguments: {
                        X: { type: ArgumentType.NUMBER, defaultValue: 0 },
                        Y: { type: ArgumentType.NUMBER, defaultValue: 0 }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledDisplay',
                    blockType: BlockType.COMMAND,
                    text: 'OLED actualizar pantalla',
                    category: 'Pantalla OLED'
                },

                // ---- AUDIO ----
                {
                    opcode: 'playTone',
                    blockType: BlockType.COMMAND,
                    text: 'Reproducir tono [FREQ] Hz por [DURATION] ms',
                    arguments: {
                        FREQ: { type: ArgumentType.NUMBER, defaultValue: 440 },
                        DURATION: { type: ArgumentType.NUMBER, defaultValue: 500 }
                    },
                    category: 'Audio'
                },
                {
                    opcode: 'stopTone',
                    blockType: BlockType.COMMAND,
                    text: 'Detener tono',
                    category: 'Audio'
                },
                {
                    opcode: 'micLevel',
                    blockType: BlockType.REPORTER,
                    text: 'Nivel de sonido del micrófono',
                    category: 'Audio'
                },

                // ---- ENTRADAS/SALIDAS playBlocks / play+ ----
                {
                    opcode: 'readDigitalPB',
                    blockType: BlockType.BOOLEAN,
                    text: 'Entrada playBlocks [PIN] activada?',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'pbInputs', defaultValue: '1' }
                    },
                    category: 'playBlocks / play+'
                },
                {
                    opcode: 'analogReadPB',
                    blockType: BlockType.REPORTER,
                    text: 'Entrada analógica playBlocks [PIN] (potenciómetro)',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'pbInputs', defaultValue: '1' }
                    },
                    category: 'playBlocks / play+'
                },
                {
                    opcode: 'writeDigitalPB',
                    blockType: BlockType.COMMAND,
                    text: 'Salida playBlocks [PIN] estado [STATE]',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'pbOutputs', defaultValue: '11' },
                        STATE: { type: ArgumentType.NUMBER, menu: 'digitalState', defaultValue: '1' }
                    },
                    category: 'playBlocks / play+'
                }
            ],
            menus: {
                wheelSide: {
                    acceptReporters: false,
                    items: [
                        { text: 'Izquierda', value: 'left' },
                        { text: 'Derecha', value: 'right' },
                        { text: 'Ambas', value: 'both' }
                    ]
                },
                wheelSideSingle: {
                    acceptReporters: false,
                    items: [
                        { text: 'Izquierda', value: 'left' },
                        { text: 'Derecha', value: 'right' }
                    ]
                },
                buttonsPlayGo: {
                    acceptReporters: false,
                    // B0-B7 en la serigrafía de la placa: dos cruces direccionales de
                    // 4 botones cada una (B0-B3 izquierda, B4-B7 derecha).
                    items: ['0', '1', '2', '3', '4', '5', '6', '7'].map(n => ({ text: `B${n}`, value: n }))
                },
                servoPorts: {
                    acceptReporters: false,
                    // A/B/C/D = mismos conectores IO11-IO14 (uso dual: salida digital o servo).
                    items: [
                        { text: 'A', value: 'A' },
                        { text: 'B', value: 'B' },
                        { text: 'C', value: 'C' },
                        { text: 'D', value: 'D' }
                    ]
                },
                rgbLeds: {
                    acceptReporters: true,
                    items: Array.from({ length: 10 }, (_, i) => ({ text: `LED RGB ${i}`, value: String(i) }))
                },
                rgbPresets: {
                    acceptReporters: false,
                    items: [
                        { text: 'Rojo', value: 'red' },
                        { text: 'Verde', value: 'green' },
                        { text: 'Azul', value: 'blue' },
                        { text: 'Amarillo', value: 'yellow' },
                        { text: 'Cian', value: 'cyan' },
                        { text: 'Magenta', value: 'magenta' },
                        { text: 'Blanco', value: 'white' },
                        { text: 'Negro', value: 'black' }
                    ]
                },
                textSize: {
                    acceptReporters: false,
                    items: [
                        { text: 'Pequeño (1)', value: '1' },
                        { text: 'Normal (2)', value: '2' },
                        { text: 'Grande (3)', value: '3' }
                    ]
                },
                oledLines: {
                    acceptReporters: false,
                    items: [
                        { text: 'Línea 1', value: '0' },
                        { text: 'Línea 2', value: '1' },
                        { text: 'Línea 3', value: '2' },
                        { text: 'Línea 4', value: '3' }
                    ]
                },
                emojiList: {
                    acceptReporters: false,
                    items: [
                        { text: ':) Feliz', value: 'smile' },
                        { text: ':( Triste', value: 'sad' },
                        { text: '<3 Corazón', value: 'heart' },
                        { text: '* Estrella', value: 'star' },
                        { text: '! Alerta', value: 'alert' },
                        { text: '? Pregunta', value: 'question' },
                        { text: '✓ Correcto', value: 'check' },
                        { text: '✗ Error', value: 'cross' },
                        { text: '^ Arriba', value: 'arrow_up' },
                        { text: 'v Abajo', value: 'arrow_down' },
                        { text: '> Derecha', value: 'arrow_right' },
                        { text: '< Izquierda', value: 'arrow_left' },
                        { text: '~ Música', value: 'music' },
                        { text: 'T Temperatura', value: 'thermometer' },
                        { text: 'W WiFi', value: 'wifi' }
                    ]
                },
                pbInputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'Entrada 1', value: '1' },
                        { text: 'Entrada 2', value: '2' },
                        { text: 'Entrada 3', value: '3' },
                        { text: 'Entrada 4', value: '4' }
                    ]
                },
                pbOutputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'Salida 1', value: '11' },
                        { text: 'Salida 2', value: '12' },
                        { text: 'Salida 3', value: '13' },
                        { text: 'Salida 4', value: '14' }
                    ]
                },
                digitalState: {
                    acceptReporters: true,
                    items: [
                        { text: 'ALTO (1)', value: '1' },
                        { text: 'BAJO (0)', value: '0' }
                    ]
                }
            }
        };
    }

    // ── Motores ──────────────────────────────────────────────────────────────

    async setMotorSpeeds(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const left = Math.max(-100, Math.min(100, parseInt(args.LEFT)));
            const right = Math.max(-100, Math.min(100, parseInt(args.RIGHT)));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setMotorSpeed', left, right }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setMotorSpeeds:', e);
        }
    }

    async stopMotors() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'stopMotors' }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en stopMotors:', e);
        }
    }

    async moveDistanceCm(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const moveId = this.peripheral._nextMoveId();
            const distanceCm = parseFloat(args.DISTANCE);
            const speed = Math.max(-100, Math.min(100, parseInt(args.SPEED)));
            const wheelDiameterCm = parseFloat(args.WHEEL_DIAM);
            const pulsesPerRev = parseInt(args.PULSES_PER_REV);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'moveDistance',
                    moveId, distanceCm, speed, wheelDiameterCm, pulsesPerRev
                }]
            });
            await this.peripheral._serial.write(json);

            const estimatedMs = Math.min(20000, Math.max(1500,
                (Math.abs(distanceCm) / Math.max(10, Math.abs(speed))) * 3000));
            await this.peripheral._waitForMoveComplete(moveId, estimatedMs + 3000);
        } catch (e) {
            console.error('Error en moveDistanceCm:', e);
        }
    }

    async turnAngleDeg(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const moveId = this.peripheral._nextMoveId();
            const angleDeg = parseFloat(args.ANGLE);
            const speed = Math.max(-100, Math.min(100, parseInt(args.SPEED)));
            const wheelDiameterCm = parseFloat(args.WHEEL_DIAM);
            const trackWidthCm = parseFloat(args.TRACK_WIDTH);
            const pulsesPerRev = parseInt(args.PULSES_PER_REV);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'turnAngle',
                    moveId, angleDeg, speed, wheelDiameterCm, trackWidthCm, pulsesPerRev
                }]
            });
            await this.peripheral._serial.write(json);

            const estimatedMs = Math.min(20000, Math.max(1500,
                (Math.abs(angleDeg) / Math.max(10, Math.abs(speed))) * 2500));
            await this.peripheral._waitForMoveComplete(moveId, estimatedMs + 3000);
        } catch (e) {
            console.error('Error en turnAngleDeg:', e);
        }
    }

    async turnWheelRevolutions(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const moveId = this.peripheral._nextMoveId();
            const wheel = args.WHEEL;
            const revolutions = parseFloat(args.REVOLUTIONS);
            const speed = Math.max(-100, Math.min(100, parseInt(args.SPEED)));
            const pulsesPerRev = parseInt(args.PULSES_PER_REV);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'turnWheelRevs',
                    moveId, wheel, revolutions, speed, pulsesPerRev
                }]
            });
            await this.peripheral._serial.write(json);

            const estimatedMs = Math.min(20000, Math.max(1500,
                (Math.abs(revolutions) / Math.max(10, Math.abs(speed))) * 4000));
            await this.peripheral._waitForMoveComplete(moveId, estimatedMs + 3000);
        } catch (e) {
            console.error('Error en turnWheelRevolutions:', e);
        }
    }

    async resetEncoders() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'resetEncoders' }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en resetEncoders:', e);
        }
    }

    getEncoderPulses(args) {
        const key = args.WHEEL === 'right' ? 'encoderRight' : 'encoderLeft';
        return this.peripheral.sensorData[key] || 0;
    }

    // A/B/C/D son los mismos conectores IO11-IO14 (uso dual con writeDigitalPB):
    // el firmware decide si el pin actúa como salida digital o como servo según
    // cuál de los dos comandos (digitalWrite/servoWrite) reciba.
    async setServoPlayGo(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const portToGpio = { A: 11, B: 12, C: 13, D: 14 };
            const gpio = portToGpio[args.PORT] || 11;
            const angle = Math.max(0, Math.min(180, parseInt(args.ANGLE)));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'servoWrite', pin: gpio, angle }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setServoPlayGo:', e);
        }
    }

    // ── Botones ──────────────────────────────────────────────────────────────

    readButtonPlayGo(args) {
        const value = this.peripheral.sensorData[`button_${args.BUTTON}`];
        return value === 1;
    }

    // ── RGB ──────────────────────────────────────────────────────────────────

    async setRGBColor(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const led = parseInt(args.LED);
            const r = Math.max(0, Math.min(255, parseInt(args.R)));
            const g = Math.max(0, Math.min(255, parseInt(args.G)));
            const b = Math.max(0, Math.min(255, parseInt(args.B)));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', led, r, g, b }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setRGBColor:', e);
        }
    }

    async setRGBColorHex(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const led = parseInt(args.LED);
            const hex = args.COLOR.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', led, r, g, b }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setRGBColorHex:', e);
        }
    }

    async setRGBPreset(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const led = parseInt(args.LED);
            const presets = {
                red: { r: 255, g: 0, b: 0 },
                green: { r: 0, g: 255, b: 0 },
                blue: { r: 0, g: 0, b: 255 },
                yellow: { r: 255, g: 255, b: 0 },
                cyan: { r: 0, g: 255, b: 255 },
                magenta: { r: 255, g: 0, b: 255 },
                white: { r: 255, g: 255, b: 255 },
                black: { r: 0, g: 0, b: 0 }
            };
            const color = presets[args.PRESET] || presets.black;
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', led, r: color.r, g: color.g, b: color.b }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setRGBPreset:', e);
        }
    }

    async rgbOff(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const led = parseInt(args.LED);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', led, r: 0, g: 0, b: 0 }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en rgbOff:', e);
        }
    }

    async allRGBOff() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', r: 0, g: 0, b: 0 }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en allRGBOff:', e);
        }
    }

    async setAllRGB(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const hex = args.COLOR.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setRGB', r, g, b }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setAllRGB:', e);
        }
    }

    // ── Pantalla OLED ────────────────────────────────────────────────────────

    async oledText(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledText', text: args.TEXT, size: parseInt(args.SIZE) }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledText:', e);
        }
    }

    async oledNumber(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledNumber',
                    line: parseInt(args.LINE),
                    label: args.LABEL,
                    value: parseInt(args.VALUE)
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledNumber:', e);
        }
    }

    async oledClear() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledClear' }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledClear:', e);
        }
    }

    async oledLine(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledLine', line: parseInt(args.LINE), text: args.TEXT }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledLine:', e);
        }
    }

    async oledTextXY(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledTextXY',
                    text: args.TEXT,
                    x: parseInt(args.X),
                    y: parseInt(args.Y),
                    size: parseInt(args.SIZE)
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledTextXY:', e);
        }
    }

    async oledEmoji(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledEmoji', emoji: args.EMOJI, x: parseInt(args.X), y: parseInt(args.Y) }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledEmoji:', e);
        }
    }

    async oledDrawLine(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledDrawLine',
                    x0: parseInt(args.X0), y0: parseInt(args.Y0),
                    x1: parseInt(args.X1), y1: parseInt(args.Y1)
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDrawLine:', e);
        }
    }

    async oledDrawRect(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledDrawRect',
                    x: parseInt(args.X), y: parseInt(args.Y),
                    w: parseInt(args.W), h: parseInt(args.H)
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDrawRect:', e);
        }
    }

    async oledFillRect(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledFillRect',
                    x: parseInt(args.X), y: parseInt(args.Y),
                    w: parseInt(args.W), h: parseInt(args.H)
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledFillRect:', e);
        }
    }

    async oledDrawCircle(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDrawCircle', x: parseInt(args.X), y: parseInt(args.Y), r: parseInt(args.R) }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDrawCircle:', e);
        }
    }

    async oledDrawPixel(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDrawPixel', x: parseInt(args.X), y: parseInt(args.Y) }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDrawPixel:', e);
        }
    }

    async oledDisplay() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDisplay' }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDisplay:', e);
        }
    }

    // ── Audio ────────────────────────────────────────────────────────────────

    async playTone(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const freq = Math.max(20, parseInt(args.FREQ));
            const durationMs = Math.max(0, parseInt(args.DURATION));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'tone', freq, durationMs }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en playTone:', e);
        }
    }

    async stopTone() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'toneStop' }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en stopTone:', e);
        }
    }

    micLevel() {
        return this.peripheral.sensorData.micLevel || 0;
    }

    // ── Entradas/Salidas playBlocks / play+ ─────────────────────────────────

    readDigitalPB(args) {
        const value = this.peripheral.sensorData[`gpio${args.PIN}`];
        return value === 1;
    }

    analogReadPB(args) {
        const raw = this.peripheral.sensorData[`pot${args.PIN}`] || 0;
        // Mapear 0-4095 (ADC de 12 bits) a 0-100, igual que PlayMe.
        return Math.round((raw / 4095) * 100);
    }

    async writeDigitalPB(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const gpio = parseInt(args.PIN);
            const value = parseInt(args.STATE);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'digitalWrite', gpio, value }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en writeDigitalPB:', e);
        }
    }
}

module.exports = PlayGo;
