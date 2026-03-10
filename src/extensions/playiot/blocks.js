const BlockType = require('../../extension-support/block-type');
const ArgumentType = require('../../extension-support/argument-type');
const PlayIotSerial = require('./playiot-serial');
const formatMessage = require('format-message');

class PlayIoTPeripheral {
    constructor(runtime, extensionId) {

        this._runtime = runtime;
        this._extensionId = extensionId;
        this._serial = new PlayIotSerial();
        this.devices = [];
        this._scanning = false;
        this._connectedDeviceId = null;
        this.buffer = ''; // Buffer para datos incompletos

        // Variables para almacenar datos de sensores
        this.sensorData = {
            button_A: 0,
            button_B: 0,
            analog_POT: 0,
            analog_X: 0,
            analog_Y: 0,
            analog_ADC33: 0,
            analog_ADC34: 0,
            analog_ADC35: 0,
            upLimit: 0,
            downLimit: 0,
            rightLimit: 0,
            leftLimit: 0
        };

        this._runtime.registerPeripheralExtension(extensionId, this);
        this._autoScan();
        window.playIotSerial = this._serial;
        window.playIotPeripheral = this;
    }

    async _autoScan() {
        try {
            if ('serial' in navigator) {
                const ports = await navigator.serial.getPorts();
                this.devices = ports;
                console.log('Auto-scan: encontrados', ports.length, 'puertos autorizados');

                if (ports.length > 0) {
                    this._runtime.emit(
                        this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                        this.getPeripheralDeviceList()
                    );
                }
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
            await navigator.serial.requestPort();

            // Usar getPorts() post-requestPort como única fuente de verdad:
            // evita duplicados que ocurren al hacer push sin verificar el estado actual.
            this.devices = await navigator.serial.getPorts();

            console.log('Total dispositivos:', this.devices.length);

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
            const deviceId = `playiot_${index}`;
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

            // Configurar el handler de datos
            this._setupDataHandler();

            // Configurar handler de desconexión inesperada
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

    // Configurar el procesamiento de datos
    _setupDataHandler() {
        if (!this._serial) return;

        // Usar el callback onData
        this._serial.onData = (data) => {
            if (data.inputs) {
                Object.keys(data.inputs).forEach(key => {
                    this.sensorData[key] = data.inputs[key];
                });
            }
        };

        console.log('Handler de datos configurado');
    }

    // Procesamiento robusto de datos de sensores
    _processSensorData(text) {
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Guardar última línea incompleta

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const data = JSON.parse(trimmed);
                if (data.inputs) {
                    // Actualizar datos de sensores
                    Object.keys(data.inputs).forEach(key => {
                        if (key in this.sensorData) {
                            this.sensorData[key] = data.inputs[key];
                        }
                    });
                }
            } catch (e) {
                console.warn('Error parseando JSON:', trimmed.substring(0, 50));
            }
        }
    }

    async disconnect() {
        console.log('Desconectando dispositivo...');

        try {
            // Limpiar buffer de datos
            this.buffer = '';

            // Resetear datos de sensores
            Object.keys(this.sensorData).forEach(key => {
                this.sensorData[key] = 0;
            });

            // Desconectar el serial
            if (this._serial) {
                await this._serial.disconnect();
            }

            // Limpiar ID de dispositivo conectado
            this._connectedDeviceId = null;

            console.log('Desconexión completada');

            // Notificar a Scratch
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);

        } catch (error) {
            console.error('Error durante desconexión:', error);

            // Forzar limpieza incluso si hay error
            this.buffer = '';
            this._connectedDeviceId = null;

            // Notificar desconexión de todos modos
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    isConnected() {
        return this._serial && this._serial.connected;
    }

    getPeripheralDeviceIds() {
        return this.devices.map((_, i) => `playiot_${i}`);
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
            this._connectedDeviceId = this._connectedDeviceId || 'playiot_0';
            this._setupDataHandler();
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
            console.log('✅ PlayIoT re-inicializado correctamente.');
        } catch (e) {
            console.error('❌ Error re-inicializando PlayIoT:', e);
        }
    }

    getSerialPort() {
        return this._serial ? this._serial.port : null;
    }

    getPeripheralName(deviceId) {
        const index = parseInt(deviceId.split('_')[1]);
        return `PlayIoT ESP32 #${index + 1}`;
    }
}

class PlayIoTBlocks {
    constructor(runtime) {
        this.runtime = runtime;
        this.peripheral = new PlayIoTPeripheral(runtime, 'playiot');
    }

    getInfo() {
        return {
            id: 'playiot',
            name: 'PlayIoT',
            color1: '#808080',
            color2: '#666666',
            color3: '#4d4d4d',
            showStatusButton: true,
            blocks: [
                // ========== SALIDAS DIGITALES ==========
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

                // ========== PWM Y VELOCIDAD ==========
                {
                    opcode: 'analogWrite',
                    blockType: BlockType.COMMAND,
                    text: 'Pin PWM [PIN] valor [VALUE]',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'pwmPins',
                            defaultValue: '12'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 128
                        }
                    },
                    category: 'Motores y PWM'
                },
                {
                    opcode: 'motorSpeed',
                    blockType: BlockType.COMMAND,
                    text: 'Motor [MOTOR] velocidad [SPEED] %',
                    arguments: {
                        MOTOR: {
                            type: ArgumentType.NUMBER,
                            menu: 'motors',
                            defaultValue: '1'
                        },
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 50
                        }
                    },
                    category: 'Motores y PWM'
                },
                {
                    opcode: 'motorStop',
                    blockType: BlockType.COMMAND,
                    text: 'Parar motor [MOTOR]',
                    arguments: {
                        MOTOR: {
                            type: ArgumentType.NUMBER,
                            menu: 'motors',
                            defaultValue: '1'
                        }
                    },
                    category: 'Motores y PWM'
                },
                {
                    opcode: 'allMotorsStop',
                    blockType: BlockType.COMMAND,
                    text: 'Parar todos los motores',
                    category: 'Motores y PWM'
                },
                {
                    opcode: 'motorDCPins',
                    blockType: BlockType.COMMAND,
                    text: 'Motor pin A:[PIN_A] pin B:[PIN_B] velocidad [SPEED]',
                    arguments: {
                        PIN_A: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 32
                        },
                        PIN_B: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 33
                        },
                        SPEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 200
                        }
                    },
                    category: 'Motores y PWM'
                },
                {
                    opcode: 'motorStopPins',
                    blockType: BlockType.COMMAND,
                    text: 'Detener motor pin A:[PIN_A] pin B:[PIN_B]',
                    arguments: {
                        PIN_A: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 32
                        },
                        PIN_B: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 33
                        }
                    },
                    category: 'Motores y PWM'
                },

                // ========== LEDS INDIVIDUALES ==========
                {
                    opcode: 'ledOn',
                    blockType: BlockType.COMMAND,
                    text: 'Encender LED [LED]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'leds',
                            defaultValue: '0'
                        }
                    },
                    category: 'LEDs'
                },
                {
                    opcode: 'ledOff',
                    blockType: BlockType.COMMAND,
                    text: 'Apagar LED [LED]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'leds',
                            defaultValue: '0'
                        }
                    },
                    category: 'LEDs'
                },
                {
                    opcode: 'ledBlink',
                    blockType: BlockType.COMMAND,
                    text: 'Parpadear LED [LED] [TIMES] veces',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'leds',
                            defaultValue: '0'
                        },
                        TIMES: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 3
                        }
                    },
                    category: 'LEDs'
                },

                // ========== LEDS RGB ==========
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

                // ========== SERVOS ==========
                {
                    opcode: 'servoWrite',
                    blockType: BlockType.COMMAND,
                    text: 'Servo [SERVO] ángulo [ANGLE]°',
                    arguments: {
                        SERVO: {
                            type: ArgumentType.NUMBER,
                            menu: 'servos',
                            defaultValue: '0'
                        },
                        ANGLE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 90
                        }
                    },
                    category: 'Servos'
                },
                {
                    opcode: 'servoCenter',
                    blockType: BlockType.COMMAND,
                    text: 'Servo [SERVO] al centro',
                    arguments: {
                        SERVO: {
                            type: ArgumentType.NUMBER,
                            menu: 'servos',
                            defaultValue: '0'
                        }
                    },
                    category: 'Servos'
                },
                {
                    opcode: 'servoSweep',
                    blockType: BlockType.COMMAND,
                    text: 'Servo [SERVO] barrido [START]° a [END]°',
                    arguments: {
                        SERVO: {
                            type: ArgumentType.NUMBER,
                            menu: 'servos',
                            defaultValue: '0'
                        },
                        START: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        },
                        END: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 180
                        }
                    },
                    category: 'Servos'
                },

                // ========== PANTALLA OLED ==========
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

                // ========== BOTONES Y ENTRADA ==========
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
                    opcode: 'buttonPressed',
                    blockType: BlockType.COMMAND,
                    text: 'Si botón [BUTTON] presionado [CONDITION]',
                    arguments: {
                        BUTTON: {
                            type: ArgumentType.STRING,
                            menu: 'buttons',
                            defaultValue: 'A'
                        },
                        CONDITION: {
                            type: ArgumentType.STRING,
                            menu: 'buttonCondition',
                            defaultValue: 'press'
                        }
                    },
                    category: 'Botones'
                },

                // ========== ENTRADAS ANALÓGICAS ==========
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
                },

                // ========== JOYSTICK ==========
                {
                    opcode: 'readJoystickAxis',
                    blockType: BlockType.REPORTER,
                    text: 'Joystick eje [AXIS]',
                    arguments: {
                        AXIS: {
                            type: ArgumentType.STRING,
                            menu: 'joystickAxis',
                            defaultValue: 'X'
                        }
                    },
                    category: 'Joystick'
                },
                {
                    opcode: 'joystickLimit',
                    blockType: BlockType.BOOLEAN,
                    text: 'Joystick [DIRECTION]?',
                    arguments: {
                        DIRECTION: {
                            type: ArgumentType.STRING,
                            menu: 'joystickDirections',
                            defaultValue: 'up'
                        }
                    },
                    category: 'Joystick'
                },
                {
                    opcode: 'joystickAngle',
                    blockType: BlockType.REPORTER,
                    text: 'Ángulo Joystick',
                    arguments: {},
                    category: 'Joystick'
                },
                {
                    opcode: 'joystickDistance',
                    blockType: BlockType.REPORTER,
                    text: 'Distancia Joystick',
                    arguments: {},
                    category: 'Joystick'
                }
            ],
            menus: {
                digitalPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'Pin 2', value: '2' },
                        { text: 'Pin 5', value: '5' },
                        { text: 'Pin 23', value: '23' }
                    ]
                },
                pwmPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'Pin 12 (M1A)', value: '12' },
                        { text: 'Pin 13 (M1B)', value: '13' },
                        { text: 'Pin 18 (M2A)', value: '18' },
                        { text: 'Pin 19 (M2B)', value: '19' }
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
                leds: {
                    acceptReporters: true,
                    items: [
                        { text: 'LED 0', value: '0' },
                        { text: 'LED 1', value: '1' },
                        { text: 'LED 2', value: '2' }
                    ]
                },
                rgbLeds: {
                    acceptReporters: true,
                    items: [
                        { text: 'LED 0', value: '0' },
                        { text: 'LED 1', value: '1' },
                        { text: 'LED 2', value: '2' }
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
                motors: {
                    acceptReporters: true,
                    items: [
                        { text: 'Motor 1', value: '1' },
                        { text: 'Motor 2', value: '2' }
                    ]
                },
                servos: {
                    acceptReporters: true,
                    items: [
                        { text: 'Servo 0 (Pin 25)', value: '0' },
                        { text: 'Servo 1 (Pin 26)', value: '1' },
                        { text: 'Servo 2 (Pin 27)', value: '2' }
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
                buttonCondition: {
                    acceptReporters: false,
                    items: [
                        { text: 'presionado', value: 'press' },
                        { text: 'soltado', value: 'release' }
                    ]
                },
                analogInputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'Potenciómetro', value: 'POT' },
                        { text: 'ADC 33', value: 'ADC33' },
                        { text: 'ADC 34', value: 'ADC34' },
                        { text: 'ADC 35', value: 'ADC35' }
                    ]
                },
                joystickAxis: {
                    acceptReporters: false,
                    items: [
                        { text: 'X', value: 'X' },
                        { text: 'Y', value: 'Y' }
                    ]
                },
                joystickDirections: {
                    acceptReporters: false,
                    items: [
                        { text: 'Arriba', value: 'up' },
                        { text: 'Abajo', value: 'down' },
                        { text: 'Izquierda', value: 'left' },
                        { text: 'Derecha', value: 'right' }
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

    // ===== IMPLEMENTACIÓN DE BLOQUES =====

    // SALIDAS DIGITALES
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
                    pin: parseInt(args.PIN),
                    value: parseInt(args.STATE)
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Pin ${args.PIN} -> ${args.STATE}`);
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
                    pin: parseInt(args.PIN),
                    value: state
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Pin ${args.PIN} -> ${args.STATE_QUICK}`);
        } catch (e) {
            console.error('Error en digitalWriteQuick:', e);
        }
    }

    // PWM Y MOTORES
    async analogWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const value = Math.max(0, Math.min(255, parseInt(args.VALUE)));
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'analogWrite',
                    pin: parseInt(args.PIN),
                    value: value
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`PWM Pin ${args.PIN} -> ${value}`);
        } catch (e) {
            console.error('Error en analogWrite:', e);
        }
    }

    async motorSpeed(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const motor = parseInt(args.MOTOR);
            const speed = Math.max(0, Math.min(100, parseInt(args.SPEED)));
            const pwmValue = Math.round(speed * 2.55); // 0-255

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'motorSpeed',
                    motor: motor,
                    speed: speed,
                    pwmValue: pwmValue
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Motor ${motor} -> ${speed}%`);
        } catch (e) {
            console.error('Error en motorSpeed:', e);
        }
    }

    async motorStop(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const motor = parseInt(args.MOTOR);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'motorStop',
                    motor: motor
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Motor ${motor} parado`);
        } catch (e) {
            console.error('Error en motorStop:', e);
        }
    }

    async allMotorsStop() {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'allMotorsStop'
                }]
            });

            await this.peripheral._serial.write(json);
            console.log('Todos los motores parados');
        } catch (e) {
            console.error('Error en allMotorsStop:', e);
        }
    }

    // LEDS INDIVIDUALES
    async ledOn(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const led = parseInt(args.LED);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'digitalWrite',
                    pin: led,
                    value: 1
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`LED ${led} encendido`);
        } catch (e) {
            console.error('Error en ledOn:', e);
        }
    }

    async ledOff(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const led = parseInt(args.LED);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'digitalWrite',
                    pin: led,
                    value: 0
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`LED ${led} apagado`);
        } catch (e) {
            console.error('Error en ledOff:', e);
        }
    }

    async ledBlink(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const led = parseInt(args.LED);
            const times = parseInt(args.TIMES);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'ledBlink',
                    pin: led,
                    times: times
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`LED ${led} parpadeando ${times} veces`);
        } catch (e) {
            console.error('Error en ledBlink:', e);
        }
    }

    // LEDS RGB
    async setRGBColor(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const led = parseInt(args.LED);
            const r = Math.max(0, Math.min(255, parseInt(args.R)));
            const g = Math.max(0, Math.min(255, parseInt(args.G)));
            const b = Math.max(0, Math.min(255, parseInt(args.B)));

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setPixelColor',
                    pixel: led,
                    valueR: r,
                    valueG: g,
                    valueB: b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED ${led} -> R:${r} G:${g} B:${b}`);
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
            const led = parseInt(args.LED);
            const color = args.COLOR;

            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setPixelColor',
                    pixel: led,
                    valueR: r,
                    valueG: g,
                    valueB: b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED ${led} -> ${color}`);
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
            const led = parseInt(args.LED);
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
                    command: 'setPixelColor',
                    pixel: led,
                    valueR: color.r,
                    valueG: color.g,
                    valueB: color.b
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED ${led} -> ${args.PRESET}`);
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
            const led = parseInt(args.LED);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'setPixelColor',
                    pixel: led,
                    valueR: 0,
                    valueG: 0,
                    valueB: 0
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`RGB LED ${led} apagado`);
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
            for (let i = 0; i < 3; i++) {
                const json = JSON.stringify({
                    command: 'outputsQueue',
                    testValue: [{
                        command: 'setPixelColor',
                        pixel: i,
                        valueR: 0,
                        valueG: 0,
                        valueB: 0
                    }]
                });
                await this.peripheral._serial.write(json);
            }
            console.log('Todos los LEDs RGB apagados');
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

            for (let i = 0; i < 3; i++) {
                const json = JSON.stringify({
                    command: 'outputsQueue',
                    testValue: [{
                        command: 'setPixelColor',
                        pixel: i,
                        valueR: r,
                        valueG: g,
                        valueB: b
                    }]
                });
                await this.peripheral._serial.write(json);
            }
            console.log(`Todos los LEDs RGB -> ${color}`);
        } catch (e) {
            console.error('Error en setAllRGB:', e);
        }
    }

    // SERVOS
    async servoWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const servo = parseInt(args.SERVO);
            const angle = Math.max(0, Math.min(180, parseInt(args.ANGLE)));

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'servoWrite',
                    pin: servo,
                    value: angle
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Servo ${servo} -> ${angle}°`);
        } catch (e) {
            console.error('Error en servoWrite:', e);
        }
    }

    async servoCenter(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const servo = parseInt(args.SERVO);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'servoWrite',
                    pin: servo,
                    value: 90
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Servo ${servo} al centro (90°)`);
        } catch (e) {
            console.error('Error en servoCenter:', e);
        }
    }

    async servoSweep(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('No conectado');
            return;
        }

        try {
            const servo = parseInt(args.SERVO);
            const start = Math.max(0, Math.min(180, parseInt(args.START)));
            const end = Math.max(0, Math.min(180, parseInt(args.END)));

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'servoSweep',
                    pin: servo,
                    startAngle: start,
                    endAngle: end
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`Servo ${servo} barrido ${start}° a ${end}°`);
        } catch (e) {
            console.error('Error en servoSweep:', e);
        }
    }

    // PANTALLA OLED
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

    async motorDCPins(args) {
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
            console.error('Error en motorDCPins:', e);
        }
    }

    async motorStopPins(args) {
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
            console.error('Error en motorStopPins:', e);
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

    // BLOQUES DE LECTURA
    readButton(args) {
        const button = args.BUTTON;
        const value = this.peripheral.sensorData[`button_${button}`];
        const isPressed = value === 1;
        return isPressed;
    }

    buttonPressed(args) {
        const button = args.BUTTON;
        const value = this.peripheral.sensorData[`button_${button}`];

        if (args.CONDITION === 'press') {
            return value === 1;
        } else {
            return value === 0;
        }
    }

    readAnalog(args) {
        const analog = args.ANALOG;
        let key = '';

        switch (analog) {
            case 'POT': key = 'analog_POT'; break;
            case 'ADC33': key = 'analog_ADC33'; break;
            case 'ADC34': key = 'analog_ADC34'; break;
            case 'ADC35': key = 'analog_ADC35'; break;
            default: return 0;
        }

        const value = this.peripheral.sensorData[key] || 0;
        return value;
    }

    analogMap(args) {
        const value = this.readAnalog({ ANALOG: args.ANALOG });
        const min = parseInt(args.MIN);
        const max = parseInt(args.MAX);

        // Mapear de 0-4095 a min-max
        const mapped = Math.round(((value / 4095) * (max - min)) + min);
        return Math.max(min, Math.min(max, mapped));
    }

    analogThreshold(args) {
        const value = this.readAnalog({ ANALOG: args.ANALOG });
        const threshold = parseInt(args.THRESHOLD);
        return value > threshold;
    }

    readJoystickAxis(args) {
        const axis = args.AXIS;
        const key = `analog_${axis}`;
        const value = this.peripheral.sensorData[key] || 0;
        return value;
    }

    joystickLimit(args) {
        const direction = args.DIRECTION;
        let key = '';

        switch (direction) {
            case 'up': key = 'upLimit'; break;
            case 'down': key = 'downLimit'; break;
            case 'left': key = 'leftLimit'; break;
            case 'right': key = 'rightLimit'; break;
            default: return false;
        }

        const value = this.peripheral.sensorData[key];
        const isAtLimit = value === 1 || value === true;
        return isAtLimit;
    }

    joystickAngle(args) {
        const x = this.peripheral.sensorData.analog_X || 0;
        const y = this.peripheral.sensorData.analog_Y || 0;

        const angle = Math.atan2(y - 2048, x - 2048) * (180 / Math.PI);
        return Math.round(angle + 180);
    }

    joystickDistance(args) {
        const x = this.peripheral.sensorData.analog_X || 0;
        const y = this.peripheral.sensorData.analog_Y || 0;

        const dx = x - 2048;
        const dy = y - 2048;
        const distance = Math.sqrt(dx * dx + dy * dy);

        return Math.round((distance / 2048) * 100);
    }
}

module.exports = PlayIoTBlocks;