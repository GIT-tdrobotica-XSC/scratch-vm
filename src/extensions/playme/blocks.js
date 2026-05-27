const BlockType = require('../../extension-support/block-type');
const ArgumentType = require('../../extension-support/argument-type');
const PlayMeSerial = require('./playme-serial');
const formatMessage = require('format-message');

class PlayMePeripheral {
    constructor(runtime, extensionId) {

        this._runtime = runtime;
        this._extensionId = extensionId;
        this._serial = new PlayMeSerial();
        this.devices = [];
        this._scanning = false;
        this._connectedDeviceId = null;
        this.buffer = '';

        this.sensorData = {
            button_A: 0,
            button_B: 0,
            pot: 0,
            gpio1: 0, gpio2: 0, gpio3: 0, gpio4: 0,
            gpio5: 0, gpio6: 0, gpio7: 0, gpio8: 0,
            gpio9: 0, gpio10: 0, gpio11: 0,
            gpio12: 0, gpio13: 0, gpio14: 0, gpio15: 0,
            gpio16: 0, gpio17: 0
        };

        // Variables para validar versión de firmware
        this.deviceFirmwareVersion = null;
        this.serverFirmwareVersion = null;
        this._firmwareVersionFetched = false;

        this._runtime.registerPeripheralExtension(extensionId, this);
        this._autoScan();
        window.playMeSerial = this._serial;
        window.playMePeripheral = this;
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
            const deviceId = `playme_${index}`;
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
                console.log('PlayMe Firmware detectado:', data.version);
            }
        };

        // Obtener versión del servidor una sola vez por conexión
        if (!this._firmwareVersionFetched) {
            this._firmwareVersionFetched = true;
            fetch(`https://playcode.tdrobotica.co/firmware/${this._extensionId}/version.txt`)
                .then(r => r.ok ? r.text() : null)
                .then(v => {
                    if (v) this.serverFirmwareVersion = v.trim();
                    console.log('PlayMe Firmware servidor:', this.serverFirmwareVersion);
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
        return this.devices.map((_, i) => `playme_${i}`);
    }

    /**
     * 🔌 Retorna el objeto SerialPort activo.
     */
    /**
     * 🔐 Reconecta el periférico después de un flasheo de firmware.
     */
    async reconnect(port) {
        if (!this._serial || !port) return;
        try {
            await this._serial.claimPort(port);
            this._connectedDeviceId = this._connectedDeviceId || 'playme_0';
            this._setupDataHandler();
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
            console.log('✅ PlayMe re-inicializado correctamente.');
        } catch (e) {
            console.error('❌ Error re-inicializando PlayMe:', e);
        }
    }

    getSerialPort() {
        return this._serial ? this._serial.port : null;
    }

    getPeripheralName(deviceId) {
        const index = parseInt(deviceId.split('_')[1]);
        return `PlayMe Device #${index + 1}`;
    }
}

class PlayMe {
    constructor(runtime, extensionId) {
        this.runtime = runtime;
        this.peripheral = new PlayMePeripheral(runtime, extensionId);
    }

    getInfo() {
        return {
            id: 'playme',
            name: 'PlayMe',
            color1: '#FF6B6B',
            color2: '#EE5A52',
            color3: '#C92A2A',
            showStatusButton: true,
            blocks: [
                {
                    opcode: 'digitalWrite',
                    blockType: BlockType.COMMAND,
                    text: 'Pin digital [PIN] estado [STATE]',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalPins',
                            defaultValue: '2'
                        },
                        STATE: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalState',
                            defaultValue: '1'
                        }
                    },
                    category: 'Salidas Digitales'
                },
                {
                    opcode: 'digitalWriteQuick',
                    blockType: BlockType.COMMAND,
                    text: 'Pin [PIN] [STATE_QUICK]',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalPins',
                            defaultValue: '2'
                        },
                        STATE_QUICK: {
                            type: ArgumentType.STRING,
                            menu: 'onOff',
                            defaultValue: 'on'
                        }
                    },
                    category: 'Salidas Digitales'
                },
                {
                    opcode: 'setRGBColor',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] R:[R] G:[G] B:[B]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'rgbLeds',
                            defaultValue: '0'
                        },
                        R: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 255
                        },
                        G: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        B: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'setRGBColorHex',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] color [COLOR]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'rgbLeds',
                            defaultValue: '0'
                        },
                        COLOR: {
                            type: ArgumentType.COLOR,
                            defaultValue: '#ff0000'
                        }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'setRGBPreset',
                    blockType: BlockType.COMMAND,
                    text: 'LED RGB [LED] [PRESET]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'rgbLeds',
                            defaultValue: '0'
                        },
                        PRESET: {
                            type: ArgumentType.STRING,
                            menu: 'rgbPresets',
                            defaultValue: 'red'
                        }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'rgbOff',
                    blockType: BlockType.COMMAND,
                    text: 'Apagar LED RGB [LED]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'rgbLeds',
                            defaultValue: '0'
                        }
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
                        COLOR: {
                            type: ArgumentType.COLOR,
                            defaultValue: '#ff0000'
                        }
                    },
                    category: 'RGB'
                },
                {
                    opcode: 'oledText',
                    blockType: BlockType.COMMAND,
                    text: 'OLED mostrar texto [TEXT] tamaño [SIZE]',
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: 'Hola'
                        },
                        SIZE: {
                            type: ArgumentType.NUMBER,
                            menu: 'textSize',
                            defaultValue: '1'
                        }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledNumber',
                    blockType: BlockType.COMMAND,
                    text: 'OLED mostrar [LABEL] valor [VALUE]',
                    arguments: {
                        LABEL: {
                            type: ArgumentType.STRING,
                            defaultValue: 'Temperatura'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 25
                        }
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
                        LINE: {
                            type: ArgumentType.NUMBER,
                            menu: 'oledLines',
                            defaultValue: '0'
                        },
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: 'Línea'
                        }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'setServo',
                    blockType: BlockType.COMMAND,
                    text: 'Servo pin [PIN] ángulo [ANGLE]°',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 13
                        },
                        ANGLE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 90
                        }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'motorDC',
                    blockType: BlockType.COMMAND,
                    text: 'Motor pin A:[PIN_A] pin B:[PIN_B] velocidad [SPEED]',
                    arguments: {
                        PIN_A: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 26
                        },
                        PIN_B: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 27
                        },
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 200
                        }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'motorStop',
                    blockType: BlockType.COMMAND,
                    text: 'Detener motor pin A:[PIN_A] pin B:[PIN_B]',
                    arguments: {
                        PIN_A: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 26
                        },
                        PIN_B: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 27
                        }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'setOledAddress',
                    blockType: BlockType.COMMAND,
                    text: 'OLED dirección I2C [ADDRESS]',
                    arguments: {
                        ADDRESS: {
                            type: ArgumentType.STRING,
                            menu: 'oledAddress',
                            defaultValue: '0x3C'
                        }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledTextXY',
                    blockType: BlockType.COMMAND,
                    text: 'OLED texto [TEXT] X:[X] Y:[Y] tamaño [SIZE]',
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: 'Hola'
                        },
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        SIZE: {
                            type: ArgumentType.NUMBER,
                            menu: 'textSize',
                            defaultValue: '1'
                        }
                    },
                    category: 'Pantalla OLED'
                },
                {
                    opcode: 'oledEmoji',
                    blockType: BlockType.COMMAND,
                    text: 'OLED emoticón [EMOJI] X:[X] Y:[Y]',
                    arguments: {
                        EMOJI: {
                            type: ArgumentType.STRING,
                            menu: 'emojiList',
                            defaultValue: 'smile'
                        },
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 48
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 16
                        }
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
                {
                    opcode: 'analogWrite',
                    blockType: BlockType.COMMAND,
                    text: 'PWM GPIO [GPIO] valor [VALUE]',
                    arguments: {
                        GPIO: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalPins',
                            defaultValue: '1'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 128
                        }
                    },
                    category: 'Salidas Digitales'
                },
                {
                    opcode: 'analogRead',
                    blockType: BlockType.REPORTER,
                    text: 'Leer GPIO analógico [GPIO]',
                    arguments: {
                        GPIO: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalPins',
                            defaultValue: '1'
                        }
                    },
                    category: 'Entradas Analógicas'
                },
                {
                    opcode: 'pinMode',
                    blockType: BlockType.COMMAND,
                    text: 'Configurar GPIO [GPIO] modo [MODE]',
                    arguments: {
                        GPIO: {
                            type: ArgumentType.NUMBER,
                            menu: 'digitalPins',
                            defaultValue: '1'
                        },
                        MODE: {
                            type: ArgumentType.STRING,
                            menu: 'pinMode',
                            defaultValue: '0'
                        }
                    },
                    category: 'Configuración'
                },
                {
                    opcode: 'readButton',
                    blockType: BlockType.BOOLEAN,
                    text: 'Botón [BUTTON] presionado?',
                    arguments: {
                        BUTTON: {
                            type: ArgumentType.STRING,
                            menu: 'buttons',
                            defaultValue: 'A'
                        }
                    },
                    category: 'Botones'
                },
                {
                    opcode: 'readAnalog',
                    blockType: BlockType.REPORTER,
                    text: 'Leer [ANALOG]',
                    arguments: {
                        ANALOG: {
                            type: ArgumentType.STRING,
                            menu: 'analogInputs',
                            defaultValue: 'POT'
                        }
                    },
                    category: 'Entradas Analógicas'
                },
                {
                    opcode: 'analogMap',
                    blockType: BlockType.REPORTER,
                    text: '[ANALOG] mapeado [MIN]-[MAX]',
                    arguments: {
                        ANALOG: {
                            type: ArgumentType.STRING,
                            menu: 'analogInputs',
                            defaultValue: 'POT'
                        },
                        MIN: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        MAX: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 100
                        }
                    },
                    category: 'Entradas Analógicas'
                },
                {
                    opcode: 'analogThreshold',
                    blockType: BlockType.BOOLEAN,
                    text: '[ANALOG] > [THRESHOLD]?',
                    arguments: {
                        ANALOG: {
                            type: ArgumentType.STRING,
                            menu: 'analogInputs',
                            defaultValue: 'POT'
                        },
                        THRESHOLD: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 2048
                        }
                    },
                    category: 'Entradas Analógicas'
                }
            ],
            menus: {
                digitalPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'GPIO 1', value: '1' },
                        { text: 'GPIO 2', value: '2' },
                        { text: 'GPIO 3', value: '3' },
                        { text: 'GPIO 4', value: '4' },
                        { text: 'GPIO 5', value: '5' },
                        { text: 'GPIO 6', value: '6' },
                        { text: 'GPIO 7', value: '7' },
                        { text: 'GPIO 8', value: '8' },
                        { text: 'GPIO 9', value: '9' },
                        { text: 'GPIO 10', value: '10' },
                        { text: 'GPIO 11', value: '11' },
                        { text: 'GPIO 12', value: '12' },
                        { text: 'GPIO 13', value: '13' },
                        { text: 'GPIO 14', value: '14' },
                        { text: 'GPIO 15', value: '15' },
                        { text: 'GPIO 16', value: '16' },
                        { text: 'GPIO 17', value: '17' }
                    ]
                },
                digitalState: {
                    acceptReporters: true,
                    items: [
                        { text: 'ALTO (1)', value: '1' },
                        { text: 'BAJO (0)', value: '0' }
                    ]
                },
                onOff: {
                    acceptReporters: false,
                    items: [
                        { text: 'ENCENDIDO', value: 'on' },
                        { text: 'APAGADO', value: 'off' }
                    ]
                },
                rgbLeds: {
                    acceptReporters: true,
                    items: [
                        { text: 'LED RGB', value: '0' }
                    ]
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
                buttons: {
                    acceptReporters: false,
                    items: [
                        { text: 'A', value: 'A' },
                        { text: 'B', value: 'B' }
                    ]
                },
                pinMode: {
                    acceptReporters: false,
                    items: [
                        { text: 'ENTRADA (INPUT)', value: '0' },
                        { text: 'SALIDA (OUTPUT)', value: '1' }
                    ]
                },
                analogInputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'Potenciómetro', value: 'POT' }
                    ]
                },
                oledAddress: {
                    acceptReporters: false,
                    items: [
                        { text: '0x3C (default)', value: '0x3C' },
                        { text: '0x3D', value: '0x3D' }
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
                }
            }
        };
    }

    async digitalWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'digitalWrite',
                    gpio: parseInt(args.PIN),
                    value: parseInt(args.STATE)
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`GPIO ${args.PIN} -> ${args.STATE}`);
        } catch (e) {
            console.error('Error en digitalWrite:', e);
        }
    }

    async digitalWriteQuick(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const state = args.STATE_QUICK === 'on' ? 1 : 0;
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'digitalWrite',
                    gpio: parseInt(args.PIN),
                    value: state
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`GPIO ${args.PIN} -> ${args.STATE_QUICK}`);
        } catch (e) {
            console.error('Error en digitalWriteQuick:', e);
        }
    }

    async setRGBColor(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const r = Math.max(0, Math.min(255, parseInt(args.R)));
            const g = Math.max(0, Math.min(255, parseInt(args.G)));
            const b = Math.max(0, Math.min(255, parseInt(args.B)));

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: r,
                    g: g,
                    b: b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED -> R:${r} G:${g} B:${b}`);
        } catch (e) {
            console.error('Error en setRGBColor:', e);
        }
    }

    async setRGBColorHex(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const color = args.COLOR;

            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: r,
                    g: g,
                    b: b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED -> ${color}`);
        } catch (e) {
            console.error('Error en setRGBColorHex:', e);
        }
    }

    async setRGBPreset(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const presets = {
                'red': { r: 255, g: 0, b: 0 },
                'green': { r: 0, g: 255, b: 0 },
                'blue': { r: 0, g: 0, b: 255 },
                'yellow': { r: 255, g: 255, b: 0 },
                'cyan': { r: 0, g: 255, b: 255 },
                'magenta': { r: 255, g: 0, b: 255 },
                'white': { r: 255, g: 255, b: 255 },
                'black': { r: 0, g: 0, b: 0 }
            };

            const color = presets[args.PRESET] || presets['black'];

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: color.r,
                    g: color.g,
                    b: color.b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED -> ${args.PRESET}`);
        } catch (e) {
            console.error('Error en setRGBPreset:', e);
        }
    }

    async rgbOff(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: 0,
                    g: 0,
                    b: 0
                }]
            });

            await this.peripheral._serial.write(json);
            console.log('RGB LED apagado');
        } catch (e) {
            console.error('Error en rgbOff:', e);
        }
    }

    async allRGBOff() {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: 0,
                    g: 0,
                    b: 0
                }]
            });
            await this.peripheral._serial.write(json);
            console.log('LED RGB apagado');
        } catch (e) {
            console.error('Error en allRGBOff:', e);
        }
    }

    async setAllRGB(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const color = args.COLOR;
            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setRGB',
                    r: r,
                    g: g,
                    b: b
                }]
            });
            await this.peripheral._serial.write(json);
            console.log(`LED RGB -> ${color}`);
        } catch (e) {
            console.error('Error en setAllRGB:', e);
        }
    }

    async analogWrite(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const gpio = parseInt(args.GPIO);
            const value = Math.max(0, Math.min(255, parseInt(args.VALUE)));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'analogWrite',
                    gpio: gpio,
                    value: value
                }]
            });
            await this.peripheral._serial.write(json);
            console.log(`PWM GPIO ${gpio} -> ${value}`);
        } catch (e) {
            console.error('Error en analogWrite:', e);
        }
    }

    async analogRead(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const gpio = parseInt(args.GPIO);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'analogRead',
                    gpio: gpio
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en analogRead:', e);
        }
    }

    async pinMode(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const gpio = parseInt(args.GPIO);
            const mode = parseInt(args.MODE);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'pinMode',
                    gpio: gpio,
                    mode: mode
                }]
            });
            await this.peripheral._serial.write(json);
            console.log(`GPIO ${gpio} modo ${mode === 0 ? 'INPUT' : 'OUTPUT'}`);
        } catch (e) {
            console.error('Error en pinMode:', e);
        }
    }

    async oledText(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledText',
                    text: args.TEXT,
                    size: parseInt(args.SIZE)
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`OLED -> ${args.TEXT}`);
        } catch (e) {
            console.error('Error en oledText:', e);
        }
    }

    async oledNumber(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledNumber',
                    label: args.LABEL,
                    value: parseInt(args.VALUE)
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`OLED -> ${args.LABEL}: ${args.VALUE}`);
        } catch (e) {
            console.error('Error en oledNumber:', e);
        }
    }

    async oledClear(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledClear'
                }]
            });

            await this.peripheral._serial.write(json);
            console.log('OLED -> LIMPIAR');
        } catch (e) {
            console.error('Error en oledClear:', e);
        }
    }

    async oledLine(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledLine',
                    line: parseInt(args.LINE),
                    text: args.TEXT
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`OLED línea ${args.LINE} -> ${args.TEXT}`);
        } catch (e) {
            console.error('Error en oledLine:', e);
        }
    }

    async setServo(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'servoWrite',
                    pin: parseInt(args.PIN),
                    angle: Math.max(0, Math.min(180, parseInt(args.ANGLE)))
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setServo:', e);
        }
    }

    async motorDC(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'motorDC',
                    pinA: parseInt(args.PIN_A),
                    pinB: parseInt(args.PIN_B),
                    speed: Math.max(-255, Math.min(255, parseInt(args.SPEED)))
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en motorDC:', e);
        }
    }

    async motorStop(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'motorDC',
                    pinA: parseInt(args.PIN_A),
                    pinB: parseInt(args.PIN_B),
                    speed: 0
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en motorStop:', e);
        }
    }

    async setOledAddress(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'oledSetAddress',
                    address: args.ADDRESS
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en setOledAddress:', e);
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
                testValue: [{
                    command: 'oledEmoji',
                    emoji: args.EMOJI,
                    x: parseInt(args.X),
                    y: parseInt(args.Y)
                }]
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
                    x0: parseInt(args.X0),
                    y0: parseInt(args.Y0),
                    x1: parseInt(args.X1),
                    y1: parseInt(args.Y1)
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
                    x: parseInt(args.X),
                    y: parseInt(args.Y),
                    w: parseInt(args.W),
                    h: parseInt(args.H)
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
                    x: parseInt(args.X),
                    y: parseInt(args.Y),
                    w: parseInt(args.W),
                    h: parseInt(args.H)
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
                testValue: [{
                    command: 'oledDrawCircle',
                    x: parseInt(args.X),
                    y: parseInt(args.Y),
                    r: parseInt(args.R)
                }]
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
                testValue: [{
                    command: 'oledDrawPixel',
                    x: parseInt(args.X),
                    y: parseInt(args.Y)
                }]
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
                testValue: [{
                    command: 'oledDisplay'
                }]
            });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('Error en oledDisplay:', e);
        }
    }

    readButton(args) {
        const button = args.BUTTON;
        const value = this.peripheral.sensorData[`button_${button}`];
        const isPressed = value === 1;
        return isPressed;
    }

    _readAnalogRaw(analog) {
        let key = '';

        switch (analog) {
            case 'POT': key = 'pot'; break;
            default: return 0;
        }

        return this.peripheral.sensorData[key] || 0;
    }

    readAnalog(args) {
        const raw = this._readAnalogRaw(args.ANALOG);
        // Mapear 0-4095 a 0-100 para que sea más fácil para estudiantes
        return Math.round((raw / 4095) * 100);
    }

    analogMap(args) {
        const raw = this._readAnalogRaw(args.ANALOG);
        const min = parseInt(args.MIN);
        const max = parseInt(args.MAX);

        // Mapear desde 0-4095 al rango personalizado
        const mapped = Math.round(((raw / 4095) * (max - min)) + min);
        return Math.max(min, Math.min(max, mapped));
    }

    analogThreshold(args) {
        const value = this.readAnalog({ ANALOG: args.ANALOG }); // Ya está mapeado 0-100
        const threshold = parseInt(args.THRESHOLD);
        return value > threshold;
    }
}

module.exports = PlayMe;