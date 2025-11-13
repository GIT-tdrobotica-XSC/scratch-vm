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
    }

    async _autoScan() {
        try {
            if ('serial' in navigator) {
                const ports = await navigator.serial.getPorts();
                this.devices = ports;
                console.log('🔍 Auto-scan: encontrados', ports.length, 'puertos autorizados');
                
                if (ports.length > 0) {
                    this._runtime.emit(
                        this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                        this.getPeripheralDeviceList()
                    );
                }
            }
        } catch (e) {
            console.warn('⚠️ Error en auto-scan:', e);
        }
    }

    async scan() {
        if (this._scanning) {
            console.log('⏳ Escaneo ya en progreso');
            return;
        }

        this._scanning = true;
        console.log('🔍 Solicitando nuevo puerto...');

        try {
            const existingPorts = await navigator.serial.getPorts();
            const newPort = await navigator.serial.requestPort();
            
            const portExists = existingPorts.some(p => p === newPort);
            if (!portExists) {
                this.devices.push(newPort);
            } else {
                this.devices = existingPorts;
            }
            
            console.log('✅ Total dispositivos:', this.devices.length);

            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this.getPeripheralDeviceList()
            );
        } catch (e) {
            if (e.name === 'NotFoundError') {
                console.log('ℹ️ Usuario canceló');
            } else {
                console.error('❌ Error en scan:', e);
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
        console.log('🔌 Intentando conectar a:', peripheralId);
        
        const index = parseInt(peripheralId.split('_')[1]);
        const port = this.devices[index];
        
        if (!port) {
            console.error('❌ Puerto no encontrado para', peripheralId);
            return;
        }

        try {
            await this._serial.connect(port);
            this._connectedDeviceId = peripheralId;
            
            // ✨ NUEVO: Configurar el handler DESPUÉS de conectar
            this._setupDataHandler();
            
            console.log('✅ Conectado exitosamente a', peripheralId);
            
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
        } catch (e) {
            console.error('❌ Error conectando:', e);
            this._connectedDeviceId = null;
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                message: `Error: ${e.message}`,
                extensionId: this._extensionId
            });
        }
    }

    // ✨ NUEVO: Configurar el procesamiento de datos
    _setupDataHandler() {
        if (!this._serial) return;
        
        // Guardar el handler original
        const originalHandler = this._serial.handleIncoming.bind(this._serial);
        
        // Extender el handler para procesar datos de sensores
        this._serial.handleIncoming = (text) => {
            // Llamar al handler original (para logs)
            originalHandler(text);
            
            // Procesar datos de sensores
            this._processSensorData(text);
        };
        
        console.log('📡 Handler de datos configurado');
    }

    // ✨ MEJORADO: Procesamiento más robusto
    _processSensorData(text) {
    this.buffer = (this.buffer || '') + text;
    const lines = this.buffer.split('\n'); // cada línea es un JSON completo
    this.buffer = lines.pop(); // deja la última línea incompleta en el buffer

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const data = JSON.parse(trimmed);
            if (data.inputs) {
                Object.keys(data.inputs).forEach(key => {
                    this.sensorData[key] = data.inputs[key];
                });
            }
            // console.log('📊 Sensores actualizados:', this.sensorData);
        } catch (e) {
            console.warn('⚠️ Error parseando JSON:', trimmed.substring(0, 50));
        }
    }
}


    async disconnect() {
        console.log('🔌 Desconectando...');
        
        // Limpiar buffer
        this.buffer = '';
        
        await this._serial.disconnect();
        this._connectedDeviceId = null;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
    }

    isConnected() {
        return this._serial.connected;
    }

    getPeripheralDeviceIds() {
        return this.devices.map((_, i) => `playiot_${i}`);
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
            color1: '#FF6600',
            color2: '#CC5200',
            color3: '#994000',
            showStatusButton: true,
            blocks: [
                // SALIDAS DIGITALES
                {
                    opcode: 'digitalWrite',
                    blockType: BlockType.COMMAND,
                    text: '🔌 Pin digital [PIN] estado [STATE]',
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
                    }
                },
                {
                    opcode: 'analogWrite',
                    blockType: BlockType.COMMAND,
                    text: '🔌 Pin PWM [PIN] valor [VALUE]',
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
                    }
                },

                '---',

                // RGB LEDS
                {
                    opcode: 'setRGBColor',
                    blockType: BlockType.COMMAND,
                    text: '🌈 LED RGB [LED] R:[R] G:[G] B:[B]',
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
                    }
                },
                {
                    opcode: 'setRGBColorHex',
                    blockType: BlockType.COMMAND,
                    text: '🌈 LED RGB [LED] color [COLOR]',
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
                    }
                },
                {
                    opcode: 'rgbOff',
                    blockType: BlockType.COMMAND,
                    text: '🌈 Apagar LED RGB [LED]',
                    arguments: {
                        LED: {
                            type: ArgumentType.NUMBER,
                            menu: 'rgbLeds',
                            defaultValue: '0'
                        }
                    }
                },
                {
                    opcode: 'allRGBOff',
                    blockType: BlockType.COMMAND,
                    text: '🌈 Apagar todos los LEDs RGB'
                },

                '---',

                // SERVOS
                {
                    opcode: 'servoWrite',
                    blockType: BlockType.COMMAND,
                    text: '🔄 Servo [SERVO] ángulo [ANGLE]°',
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
                    }
                },

                '---',

                // ENTRADAS DIGITALES
                {
                    opcode: 'readButton',
                    blockType: BlockType.BOOLEAN,
                    text: '🔘 Botón [BUTTON] presionado?',
                    arguments: {
                        BUTTON: {
                            type: ArgumentType.STRING,
                            menu: 'buttons',
                            defaultValue: 'A'
                        }
                    }
                },

                '---',

                // ENTRADAS ANALÓGICAS
                {
                    opcode: 'readAnalog',
                    blockType: BlockType.REPORTER,
                    text: '📊 Leer [ANALOG]',
                    arguments: {
                        ANALOG: {
                            type: ArgumentType.STRING,
                            menu: 'analogInputs',
                            defaultValue: 'POT'
                        }
                    }
                },

                '---',

                // JOYSTICK
                {
                    opcode: 'readJoystickAxis',
                    blockType: BlockType.REPORTER,
                    text: '🕹️ Joystick eje [AXIS]',
                    arguments: {
                        AXIS: {
                            type: ArgumentType.STRING,
                            menu: 'joystickAxis',
                            defaultValue: 'X'
                        }
                    }
                },
                {
                    opcode: 'joystickLimit',
                    blockType: BlockType.BOOLEAN,
                    text: '🕹️ Joystick [DIRECTION]?',
                    arguments: {
                        DIRECTION: {
                            type: ArgumentType.STRING,
                            menu: 'joystickDirections',
                            defaultValue: 'up'
                        }
                    }
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
                rgbLeds: {
                    acceptReporters: true,
                    items: [
                        { text: 'LED 0', value: '0' },
                        { text: 'LED 1', value: '1' },
                        { text: 'LED 2', value: '2' }
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
                        { text: '↑ Arriba', value: 'up' },
                        { text: '↓ Abajo', value: 'down' },
                        { text: '← Izquierda', value: 'left' },
                        { text: '→ Derecha', value: 'right' }
                    ]
                }
            }
        };
    }

    // ===== IMPLEMENTACIÓN DE BLOQUES =====

    async digitalWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`📌 Pin ${args.PIN} -> ${args.STATE}`);
        } catch (e) {
            console.error('❌ Error en digitalWrite:', e);
        }
    }

    async analogWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`📊 PWM Pin ${args.PIN} -> ${value}`);
        } catch (e) {
            console.error('❌ Error en analogWrite:', e);
        }
    }

    async setRGBColor(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`🎨 RGB LED ${led} -> R:${r} G:${g} B:${b}`);
        } catch (e) {
            console.error('❌ Error en setRGBColor:', e);
        }
    }

    async setRGBColorHex(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`🎨 RGB LED ${led} -> ${color}`);
        } catch (e) {
            console.error('❌ Error en setRGBColorHex:', e);
        }
    }

    async rgbOff(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`💡 RGB LED ${led} apagado`);
        } catch (e) {
            console.error('❌ Error en rgbOff:', e);
        }
    }

    async allRGBOff() {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log('💡 Todos los LEDs RGB apagados');
        } catch (e) {
            console.error('❌ Error en allRGBOff:', e);
        }
    }

    async servoWrite(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
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
            console.log(`🔄 Servo ${servo} -> ${angle}°`);
        } catch (e) {
            console.error('❌ Error en servoWrite:', e);
        }
    }

    // ✨ MEJORADO: Bloques de lectura con logs para debug
    readButton(args) {
        const button = args.BUTTON;
        const value = this.peripheral.sensorData[`button_${button}`];
        const isPressed = value === 1;
        
        // Log para debug (puedes comentarlo después)
        console.log(`🔘 Botón ${button}: ${value} (${isPressed ? 'presionado' : 'no presionado'})`);
        
        return isPressed;
    }

    readAnalog(args) {
        const analog = args.ANALOG;
        let key = '';
        
        switch(analog) {
            case 'POT': key = 'analog_POT'; break;
            case 'ADC33': key = 'analog_ADC33'; break;
            case 'ADC34': key = 'analog_ADC34'; break;
            case 'ADC35': key = 'analog_ADC35'; break;
            default: return 0;
        }
        
        const value = this.peripheral.sensorData[key] || 0;
        
        // Log para debug (puedes comentarlo después)
        console.log(`📊 ${analog}: ${value}`);
        
        return value;
    }

    readJoystickAxis(args) {
        const axis = args.AXIS;
        const key = `analog_${axis}`;
        const value = this.peripheral.sensorData[key] || 0;
        
        // Log para debug (puedes comentarlo después)
        console.log(`🕹️ Joystick ${axis}: ${value}`);
        
        return value;
    }

    joystickLimit(args) {
        const direction = args.DIRECTION;
        let key = '';
        
        switch(direction) {
            case 'up': key = 'upLimit'; break;
            case 'down': key = 'downLimit'; break;
            case 'left': key = 'leftLimit'; break;
            case 'right': key = 'rightLimit'; break;
            default: return false;
        }
        
        const value = this.peripheral.sensorData[key];
        const isAtLimit = value === 1 || value === true;
        
        // Log para debug (puedes comentarlo después)
        console.log(`🕹️ Joystick límite ${direction}: ${value} (${isAtLimit})`);
        
        return isAtLimit;
    }
}

module.exports = PlayIoTBlocks;