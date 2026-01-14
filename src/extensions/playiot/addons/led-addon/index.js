const BlockType = require('../../../../extension-support/block-type');
const ArgumentType = require('../../../../extension-support/argument-type');

class LEDAddon {
    constructor(runtime, peripheral) {
        this.runtime = runtime;
        this.peripheral = peripheral;
    }

    getInfo() {
        return {
            id: 'playiot-led-addon',
            name: 'LED Control',
            color1: '#FFD700',
            color2: '#FFC700',
            color3: '#FFB700',
            blocks: [
                {
                    opcode: 'ledOn',
                    blockType: BlockType.COMMAND,
                    text: '💡 LED [PIN] encender',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'ledPins',
                            defaultValue: '2'
                        }
                    }
                },
                {
                    opcode: 'ledOff',
                    blockType: BlockType.COMMAND,
                    text: '💡 LED [PIN] apagar',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'ledPins',
                            defaultValue: '2'
                        }
                    }
                },
                {
                    opcode: 'ledPWM',
                    blockType: BlockType.COMMAND,
                    text: '💡 LED [PIN] brillo [VALUE]',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'pwmLedPins',
                            defaultValue: '12'
                        },
                        VALUE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 128
                        }
                    }
                },
                {
                    opcode: 'ledToggle',
                    blockType: BlockType.COMMAND,
                    text: '💡 LED [PIN] alternar',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'ledPins',
                            defaultValue: '2'
                        }
                    }
                }
            ],
            menus: {
                ledPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'Pin 2', value: '2' },
                        { text: 'Pin 5', value: '5' },
                        { text: 'Pin 23', value: '23' }
                    ]
                },
                pwmLedPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'Pin 12', value: '12' },
                        { text: 'Pin 13', value: '13' },
                        { text: 'Pin 18', value: '18' },
                        { text: 'Pin 19', value: '19' }
                    ]
                }
            }
        };
    }

    // 🔴 IMPLEMENTACIÓN DE BLOQUES

    async ledOn(args) {
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
                    value: 1
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`💡 LED Pin ${args.PIN} -> ENCENDIDO`);
        } catch (e) {
            console.error('❌ Error en ledOn:', e);
        }
    }

    async ledOff(args) {
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
                    value: 0
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`💡 LED Pin ${args.PIN} -> APAGADO`);
        } catch (e) {
            console.error('❌ Error en ledOff:', e);
        }
    }

    async ledPWM(args) {
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
            console.log(`💡 LED Pin ${args.PIN} -> Brillo ${value}`);
        } catch (e) {
            console.error('❌ Error en ledPWM:', e);
        }
    }

    async ledToggle(args) {
        if (!this.peripheral.isConnected()) {
            console.warn('⚠️ No conectado');
            return;
        }

        try {
            // Alternar entre 0 y 1
            const currentState = this.peripheral.ledState?.[args.PIN] || 0;
            const newState = currentState === 0 ? 1 : 0;
            
            // Guardar estado
            if (!this.peripheral.ledState) {
                this.peripheral.ledState = {};
            }
            this.peripheral.ledState[args.PIN] = newState;

            const json = JSON.stringify({
                command: 'outputsQueue',
                testValue: [{
                    command: 'digitalWrite',
                    pin: parseInt(args.PIN),
                    value: newState
                }]
            });

            await this.peripheral._serial.write(json);
            console.log(`💡 LED Pin ${args.PIN} -> ALTERNADO (${newState})`);
        } catch (e) {
            console.error('❌ Error en ledToggle:', e);
        }
    }
}

module.exports = LEDAddon;