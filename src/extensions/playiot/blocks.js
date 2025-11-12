const BlockType = require('../../extension-support/block-type');
const ArgumentType = require('../../extension-support/argument-type');
const PlayIotSerial = require('./playiot-serial');
const formatMessage = require('format-message');

class PlayIoTPeripheral {
    constructor(runtime, extensionId) {
        this._runtime = runtime;
        this._extensionId = extensionId;
        this._serial = new PlayIotSerial();

        this._runtime.registerPeripheralExtension(extensionId, this);
    }

    // Scratch llama a estos métodos desde el botón naranja
    scan() { return this._serial.scan(); }
    connect() { return this._serial.connect(); }
    disconnect() { return this._serial.disconnect(); }
    isConnected() { return this._serial.connected; }
}

class PlayIoTBlocks {
    constructor(runtime) {
        this.runtime = runtime;
        this._peripheral = new PlayIoTPeripheral(runtime, 'playiot');
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
        const json = JSON.stringify({ cmd: 'LED', state: 'ON' });
        await this._peripheral._serial.write(json);
    }

    async ledOff() {
        const json = JSON.stringify({ cmd: 'LED', state: 'OFF' });
        await this._peripheral._serial.write(json);
    }
}

module.exports = PlayIoTBlocks;
