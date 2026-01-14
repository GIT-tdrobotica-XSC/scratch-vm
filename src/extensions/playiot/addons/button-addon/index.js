const BlockType = require('../../../../extension-support/block-type');
const ArgumentType = require('../../../../extension-support/argument-type');

class ButtonAddon {
    constructor(runtime, peripheral) {
        this.runtime = runtime;
        this.peripheral = peripheral;
        
        // Almacenar estado anterior para detectar cambios
        this.previousState = {};
    }

    getInfo() {
        return {
            id: 'playiot-button-addon',
            name: 'Button Control',
            color1: '#FF6B6B',
            color2: '#FF5252',
            color3: '#FF3838',
            blocks: [
                {
                    opcode: 'buttonPressed',
                    blockType: BlockType.BOOLEAN,
                    text: '🔘 Botón [PIN] presionado?',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'buttonPins',
                            defaultValue: '14'
                        }
                    }
                },
                {
                    opcode: 'whenButtonPressed',
                    blockType: BlockType.HAT,
                    text: '🔘 Cuando botón [PIN] se presiona',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'buttonPins',
                            defaultValue: '14'
                        }
                    }
                },
                {
                    opcode: 'whenButtonReleased',
                    blockType: BlockType.HAT,
                    text: '🔘 Cuando botón [PIN] se suelta',
                    arguments: {
                        PIN: {
                            type: ArgumentType.NUMBER,
                            menu: 'buttonPins',
                            defaultValue: '14'
                        }
                    }
                }
            ],
            menus: {
                buttonPins: {
                    acceptReporters: true,
                    items: [
                        { text: 'Pin 14 (A)', value: '14' },
                        { text: 'Pin 15 (B)', value: '15' }
                    ]
                }
            }
        };
    }

    // 🔴 IMPLEMENTACIÓN DE BLOQUES

    buttonPressed(args) {
        const pin = args.PIN;
        
        // Mapear pines a nombres de sensores
        let sensorKey = '';
        switch(pin) {
            case '14': sensorKey = 'button_A'; break;
            case '15': sensorKey = 'button_B'; break;
            default: return false;
        }

        const value = this.peripheral.sensorData?.[sensorKey] || 0;
        return value === 1;
    }

    whenButtonPressed(args) {
        const pin = args.PIN;
        
        // Mapear pines a nombres de sensores
        let sensorKey = '';
        switch(pin) {
            case '14': sensorKey = 'button_A'; break;
            case '15': sensorKey = 'button_B'; break;
            default: return false;
        }

        const currentState = this.peripheral.sensorData?.[sensorKey] || 0;
        const previousState = this.previousState[pin] || 0;

        // Detectar cambio de 0 a 1 (presión)
        if (currentState === 1 && previousState === 0) {
            this.previousState[pin] = currentState;
            console.log(`🔘 Botón Pin ${pin} PRESIONADO`);
            return true;
        }

        this.previousState[pin] = currentState;
        return false;
    }

    whenButtonReleased(args) {
        const pin = args.PIN;
        
        // Mapear pines a nombres de sensores
        let sensorKey = '';
        switch(pin) {
            case '14': sensorKey = 'button_A'; break;
            case '15': sensorKey = 'button_B'; break;
            default: return false;
        }

        const currentState = this.peripheral.sensorData?.[sensorKey] || 0;
        const previousState = this.previousState[pin] || 0;

        // Detectar cambio de 1 a 0 (suelta)
        if (currentState === 0 && previousState === 1) {
            this.previousState[pin] = currentState;
            console.log(`🔘 Botón Pin ${pin} SOLTADO`);
            return true;
        }

        this.previousState[pin] = currentState;
        return false;
    }
}

module.exports = ButtonAddon;