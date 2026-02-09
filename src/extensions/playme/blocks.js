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
            analog_POT: 0
        };

        this._runtime.registerPeripheralExtension(extensionId, this);
        this._autoScan();
        window.playMeSerial = this._serial;
        window.playMePeripheral = this;
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
            const existingPorts = await navigator.serial.getPorts();
            const newPort = await navigator.serial.requestPort();

            const portExists = existingPorts.some(p => p === newPort);
            if (!portExists) {
                this.devices.push(newPort);
            } else {
                this.devices = existingPorts;
            }

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
        };

        console.log('Handler de datos configurado');
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

            console.log('Desconexión completada');

            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);

        } catch (error) {
            console.error('Error durante desconexión:', error);

            this.buffer = '';
            this._connectedDeviceId = null;

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
            this._setupDataHandler();
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
                        { text: 'Pin 2', value: '2' },
                        { text: 'Pin 5', value: '5' },
                        { text: 'Pin 23', value: '23' }
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
                analogInputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'Potenciómetro', value: 'POT' }
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

    readButton(args) {
        const button = args.BUTTON;
        const value = this.peripheral.sensorData[`button_${button}`];
        const isPressed = value === 1;
        return isPressed;
    }

    readAnalog(args) {
        const analog = args.ANALOG;
        let key = '';

        switch (analog) {
            case 'POT': key = 'analog_POT'; break;
            default: return 0;
        }

        const value = this.peripheral.sensorData[key] || 0;
        return value;
    }

    analogMap(args) {
        const value = this.readAnalog({ ANALOG: args.ANALOG });
        const min = parseInt(args.MIN);
        const max = parseInt(args.MAX);

        const mapped = Math.round(((value / 4095) * (max - min)) + min);
        return Math.max(min, Math.min(max, mapped));
    }

    analogThreshold(args) {
        const value = this.readAnalog({ ANALOG: args.ANALOG });
        const threshold = parseInt(args.THRESHOLD);
        return value > threshold;
    }
}

module.exports = PlayMe;