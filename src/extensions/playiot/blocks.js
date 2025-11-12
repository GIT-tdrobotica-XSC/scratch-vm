const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const PlayIotSerial = require('./playiot-serial');

class PlayIot {
    constructor(runtime) {
        this.runtime = runtime;
        this.serial = new PlayIotSerial();
    }

    getInfo() {
        return {
            id: 'playiot',
            name: 'PlayIoT',
            color1: '#FF6600',
            color2: '#CC5200',
            color3: '#994000',

            blocks: [
                {
                    opcode: 'connect',
                    blockType: BlockType.COMMAND,
                    text: 'Conectar a dispositivo PlayIoT',
                },
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

    async connect() {
        await this.serial.connect();
    }

    async ledOn() {
        const json = JSON.stringify({ cmd: 'LED', state: 'ON' });
        await this.serial.write(json);
    }

    async ledOff() {
        const json = JSON.stringify({ cmd: 'LED', state: 'OFF' });
        await this.serial.write(json);
    }
}

module.exports = PlayIot;
