const BlockType = require('../../extension-support/block-type');
const ArgumentType = require('../../extension-support/argument-type');
const PlayBoardSerial = require('./playboard-serial');

/**
 * PlayBoard + PlayShield V2 — Arduino UNO (ATmega328p).
 *
 * Dispositivo de solo-USB (el ATmega328p no tiene inalámbrico). Se conecta por
 * Web Serial con reset DTR (ver playboard-serial.js). Protocolo JSON-por-línea,
 * igual que los demás dispositivos.
 *
 * Mapa de pines (según la placa):
 *   A0            → Potenciómetro
 *   A1, A2, A3    → Entradas analógicas
 *   A4, A5        → I2C (pantalla OLED)
 *   D2,D4,D7,D8,D9,D10 → Entrada/Salida digital
 *   D3, D11       → Driver Motor M1 (H-puente doble PWM)
 *   D5, D6        → Driver Motor M2 (H-puente doble PWM)
 *   D12, D13      → Botones 1 y 2
 */
class PlayBoardPeripheral {
    constructor(runtime, extensionId) {
        this._runtime = runtime;
        this._extensionId = extensionId;
        this._serial = new PlayBoardSerial();
        this._activeTransport = null;
        this.devices = [];
        this._scanning = false;
        this._connectedDeviceId = null;
        this.buffer = '';

        // Telemetría de la placa (poblada por onData). Solo entradas: los pines
        // digitales bidireccionales se reportan como digitalRead (INPUT_PULLUP)
        // salvo que se usen como salida con writeDigital.
        this.sensorData = {
            pot: 0,            // A0 (0-1023)
            a1: 0, a2: 0, a3: 0, // A1-A3 (0-1023)
            d2: 0, d4: 0, d7: 0, d8: 0, d9: 0, d10: 0, // D2..D10 (0/1)
            btn1: 0, btn2: 0   // D12, D13 (0/1)
        };

        // Versión de firmware (solo lectura/diagnóstico; PlayBoard NO tiene
        // actualizador en PlayCode — el UNO se flashea con Arduino IDE).
        this.deviceFirmwareVersion = null;

        // Caches de deduplicación (se resetean en cada connect()): un bloque de
        // motor dentro de un "por siempre" se evalúa decenas de veces/segundo;
        // sin dedupe, se reenviaría el mismo comando saturando el serial.
        this._lastMotorJson = null;   // último comando de motor (JSON literal)
        this._lastDigitalState = {};  // último valor escrito por pin {pin: value}

        this._runtime.registerPeripheralExtension(extensionId, this);
        this._autoScan();
        window.playBoardSerial = this._serial;
        window.playBoardPeripheral = this;
    }

    async _autoScan() {
        try {
            if ('serial' in navigator) {
                const ports = await navigator.serial.getPorts();
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
        if (this._scanning) return;
        this._scanning = true;
        try {
            // PlayBoard es solo-USB. El picker nativo del navegador se abre
            // recién al hacer click en la opción (connect()), gesto válido para
            // requestPort().
            this.devices = [{ type: 'usb', name: 'PlayBoard por USB' }];
            setTimeout(() => {
                this._runtime.emit(
                    this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                    this.getPeripheralDeviceList()
                );
            }, 100);
        } finally {
            this._scanning = false;
        }
    }

    getPeripheralDeviceList() {
        return this.devices.map((entry, index) => {
            const deviceId = `playboard_${index}`;
            return {
                id: deviceId,
                peripheralId: deviceId,
                name: entry.name,
                rssi: -50,
                connected: this._connectedDeviceId === deviceId
            };
        });
    }

    async connect(peripheralId) {
        console.log('Intentando conectar a:', peripheralId);

        const index = parseInt(peripheralId.split('_')[1]);
        const entry = this.devices[index];
        if (!entry) {
            console.error('Opción de conexión no encontrada para', peripheralId);
            return;
        }

        try {
            // Abrir el picker de puertos seriales (gesto de usuario del click).
            const port = await navigator.serial.requestPort();
            await this._serial.connect(port);
            this._activeTransport = this._serial;

            this._connectedDeviceId = peripheralId;

            // Placa recién conectada: motores detenidos, salidas en reposo.
            this._lastMotorJson = null;
            this._lastDigitalState = {};

            this._setupDataHandler();

            this._activeTransport.onDisconnect = () => {
                // Pérdida definitiva (USB desenchufado). Avisar VISIBLEMENTE al
                // usuario (alerta) + resetear estado (botón/toast).
                console.warn('[PlayBoard] Conexión perdida');
                this._connectedDeviceId = null;
                this._activeTransport = null;
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
                    message: 'Scratch lost connection to',
                    extensionId: this._extensionId
                });
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
            };

            console.log('Conectado exitosamente a', peripheralId);
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
        } catch (e) {
            if (e && e.name === 'NotFoundError') {
                console.log('Usuario canceló la selección');
            } else {
                console.error('Error conectando:', e);
            }
            this._connectedDeviceId = null;
            this._activeTransport = null;
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                message: `Error: ${e.message}`,
                extensionId: this._extensionId
            });
        }
    }

    async send(msg) {
        const transport = this._activeTransport || this._serial;
        return transport.write(msg);
    }

    _setupDataHandler() {
        const transport = this._activeTransport || this._serial;
        if (!transport) return;

        transport.onData = (data) => {
            if (data.inputs) {
                Object.keys(data.inputs).forEach(key => {
                    this.sensorData[key] = data.inputs[key];
                });
            }
            if (data.version && data.version !== this.deviceFirmwareVersion) {
                this.deviceFirmwareVersion = data.version;
                console.log('PlayBoard Firmware detectado:', data.version);
            }
        };
        console.log('Handler de datos configurado');
    }

    async disconnect() {
        console.log('Desconectando dispositivo...');
        try {
            this.buffer = '';
            Object.keys(this.sensorData).forEach(key => { this.sensorData[key] = 0; });

            if (this._activeTransport) {
                await this._activeTransport.disconnect();
            } else if (this._serial) {
                await this._serial.disconnect();
            }
            this._activeTransport = null;
            this._connectedDeviceId = null;
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
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    isConnected() {
        const transport = this._activeTransport;
        return !!(transport && transport.connected);
    }

    getPeripheralDeviceIds() {
        return this.devices.map((_, i) => `playboard_${i}`);
    }

    getSerialPort() {
        return this._serial ? this._serial.port : null;
    }

    // PlayBoard no tiene actualizador de firmware en PlayCode (el ATmega328p se
    // flashea con Arduino IDE, no con esptool). Se reporta siempre 'unknown'
    // para que la GUI no ofrezca una actualización imposible.
    getFirmwareStatus() {
        return 'unknown';
    }

    getPeripheralName(deviceId) {
        const index = parseInt(deviceId.split('_')[1]);
        const entry = this.devices[index];
        return (entry && entry.name) || `PlayBoard #${index + 1}`;
    }
}

class PlayBoard {
    constructor(runtime, extensionId) {
        this.runtime = runtime;
        this.peripheral = new PlayBoardPeripheral(runtime, extensionId);
    }

    getInfo() {
        return {
            id: 'playboard',
            name: 'PlayBoard + PlayShield',
            color1: '#F5A623',
            color2: '#E08E0B',
            color3: '#B5730A',
            showStatusButton: true,
            blocks: [
                // ---- MOTORES ----
                {
                    opcode: 'setMotorSpeeds',
                    blockType: BlockType.COMMAND,
                    text: 'Motores  M1:[M1]%  M2:[M2]%',
                    arguments: {
                        M1: { type: ArgumentType.NUMBER, defaultValue: 50 },
                        M2: { type: ArgumentType.NUMBER, defaultValue: 50 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'setMotor',
                    blockType: BlockType.COMMAND,
                    text: 'Motor [MOTOR] velocidad [SPEED]%',
                    arguments: {
                        MOTOR: { type: ArgumentType.STRING, menu: 'motors', defaultValue: '1' },
                        SPEED: { type: ArgumentType.NUMBER, defaultValue: 50 }
                    },
                    category: 'Motores'
                },
                {
                    opcode: 'stopMotors',
                    blockType: BlockType.COMMAND,
                    text: 'Detener motores',
                    category: 'Motores'
                },

                // ---- SENSORES ----
                {
                    opcode: 'readPotentiometer',
                    blockType: BlockType.REPORTER,
                    text: 'Potenciómetro',
                    category: 'Sensores'
                },
                {
                    opcode: 'readAnalog',
                    blockType: BlockType.REPORTER,
                    text: 'Entrada analógica [PIN]',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'analogInputs', defaultValue: 'a1' }
                    },
                    category: 'Sensores'
                },
                {
                    opcode: 'readButton',
                    blockType: BlockType.BOOLEAN,
                    text: 'Botón [BUTTON] presionado?',
                    arguments: {
                        BUTTON: { type: ArgumentType.STRING, menu: 'buttons', defaultValue: 'btn1' }
                    },
                    category: 'Sensores'
                },

                // ---- ENTRADA/SALIDA DIGITAL ----
                {
                    opcode: 'readDigital',
                    blockType: BlockType.BOOLEAN,
                    text: 'Entrada digital [PIN] activa?',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'digitalPins', defaultValue: '2' }
                    },
                    category: 'Digital'
                },
                {
                    opcode: 'writeDigital',
                    blockType: BlockType.COMMAND,
                    text: 'Salida digital [PIN] [STATE]',
                    arguments: {
                        PIN: { type: ArgumentType.STRING, menu: 'digitalPins', defaultValue: '2' },
                        STATE: { type: ArgumentType.STRING, menu: 'digitalState', defaultValue: '1' }
                    },
                    category: 'Digital'
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
                        LABEL: { type: ArgumentType.STRING, defaultValue: 'Valor' },
                        VALUE: { type: ArgumentType.NUMBER, defaultValue: 0 }
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
                }
            ],
            menus: {
                motors: {
                    acceptReporters: false,
                    items: [
                        { text: 'M1', value: '1' },
                        { text: 'M2', value: '2' }
                    ]
                },
                analogInputs: {
                    acceptReporters: false,
                    items: [
                        { text: 'A1', value: 'a1' },
                        { text: 'A2', value: 'a2' },
                        { text: 'A3', value: 'a3' }
                    ]
                },
                buttons: {
                    acceptReporters: false,
                    items: [
                        { text: 'Botón 1 (D12)', value: 'btn1' },
                        { text: 'Botón 2 (D13)', value: 'btn2' }
                    ]
                },
                digitalPins: {
                    acceptReporters: false,
                    // Valor = número de pin Arduino (para digitalWrite en firmware);
                    // la lectura usa la clave 'd'+pin en sensorData.
                    items: [
                        { text: 'D2', value: '2' },
                        { text: 'D4', value: '4' },
                        { text: 'D7', value: '7' },
                        { text: 'D8', value: '8' },
                        { text: 'D9', value: '9' },
                        { text: 'D10', value: '10' }
                    ]
                },
                digitalState: {
                    acceptReporters: false,
                    items: [
                        { text: 'Encendido', value: '1' },
                        { text: 'Apagado', value: '0' }
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
                }
            }
        };
    }

    // ── MOTORES ──────────────────────────────────────────────────────────────
    _clampSpeed(v) {
        v = parseInt(v);
        if (isNaN(v)) return 0;
        return Math.max(-100, Math.min(100, v));
    }

    async setMotorSpeeds(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const m1 = this._clampSpeed(args.M1);
            const m2 = this._clampSpeed(args.M2);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setMotors', m1, m2 }]
            });
            // Dedupe: dentro de un "por siempre" este bloque se evalúa muchas
            // veces/segundo; solo reenviar si el comando cambió.
            if (this.peripheral._lastMotorJson === json) return;
            this.peripheral._lastMotorJson = json;
            await this.peripheral.send(json);
        } catch (e) {
            console.error('Error en setMotorSpeeds:', e);
        }
    }

    async setMotor(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const motor = parseInt(args.MOTOR);
            const speed = this._clampSpeed(args.SPEED);
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'setMotor', motor, speed }]
            });
            if (this.peripheral._lastMotorJson === json) return;
            this.peripheral._lastMotorJson = json;
            await this.peripheral.send(json);
        } catch (e) {
            console.error('Error en setMotor:', e);
        }
    }

    async stopMotors() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'stopMotors' }]
            });
            this.peripheral._lastMotorJson = json;
            await this.peripheral.send(json);
        } catch (e) {
            console.error('Error en stopMotors:', e);
        }
    }

    // ── SENSORES ─────────────────────────────────────────────────────────────
    readPotentiometer() {
        return this.peripheral.sensorData.pot || 0;
    }

    readAnalog(args) {
        return this.peripheral.sensorData[args.PIN] || 0;
    }

    readButton(args) {
        return this.peripheral.sensorData[args.BUTTON] === 1;
    }

    // ── ENTRADA/SALIDA DIGITAL ───────────────────────────────────────────────
    readDigital(args) {
        return this.peripheral.sensorData['d' + args.PIN] === 1;
    }

    async writeDigital(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const pin = parseInt(args.PIN);
            const value = parseInt(args.STATE) ? 1 : 0;
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'digitalWrite', pin, value }]
            });
            // Dedupe por pin: no reenviar el mismo valor repetidamente.
            if (this.peripheral._lastDigitalState[pin] === value) return;
            this.peripheral._lastDigitalState[pin] = value;
            await this.peripheral.send(json);
        } catch (e) {
            console.error('Error en writeDigital:', e);
        }
    }

    // ── PANTALLA OLED ────────────────────────────────────────────────────────
    async oledText(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledText', text: args.TEXT, size: parseInt(args.SIZE) }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledText:', e); }
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
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledNumber:', e); }
    }

    async oledClear() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledClear' }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledClear:', e); }
    }

    async oledLine(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledLine', line: parseInt(args.LINE), text: args.TEXT }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledLine:', e); }
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
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledTextXY:', e); }
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
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledDrawLine:', e); }
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
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledDrawRect:', e); }
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
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledFillRect:', e); }
    }

    async oledDrawCircle(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDrawCircle', x: parseInt(args.X), y: parseInt(args.Y), r: parseInt(args.R) }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledDrawCircle:', e); }
    }

    async oledDrawPixel(args) {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDrawPixel', x: parseInt(args.X), y: parseInt(args.Y) }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledDrawPixel:', e); }
    }

    async oledDisplay() {
        if (!this.peripheral.isConnected()) return;
        try {
            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{ command: 'oledDisplay' }]
            });
            await this.peripheral.send(json);
        } catch (e) { console.error('Error en oledDisplay:', e); }
    }
}

module.exports = PlayBoard;
