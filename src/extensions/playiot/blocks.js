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

        this._runtime.registerPeripheralExtension(extensionId, this);
        
        // Auto-escanear al inicio
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
            
            // Agregar solo si no existe
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

    async disconnect() {
        console.log('🔌 Desconectando...');
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
                {
                    opcode: 'ledOn',
                    blockType: BlockType.COMMAND,
                    text: 'Encender LED',
                },
                {
                    opcode: 'ledOff',
                    blockType: BlockType.COMMAND,
                    text: 'Apagar LED',
                }
            ]
        };
    }

    async ledOn() {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado - no se puede encender LED');
            return;
        }
        try {
            const json = JSON.stringify({ cmd: 'LED', state: 'ON' });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('❌ Error enviando ledOn:', e);
        }
    }

    async ledOff() {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado - no se puede apagar LED');
            return;
        }
        try {
            const json = JSON.stringify({ cmd: 'LED', state: 'OFF' });
            await this.peripheral._serial.write(json);
        } catch (e) {
            console.error('❌ Error enviando ledOff:', e);
        }
    }
}

module.exports = PlayIoTBlocks;