/**
 * Emisor de bytecode: buffer de bytes que crece, con etiquetas y parcheo de
 * saltos hacia adelante.
 *
 * El problema que resuelve: al compilar `si <cond> entonces <cuerpo>` hay que
 * emitir un `JZ` al final del cuerpo ANTES de saber dónde termina el cuerpo. La
 * solución clásica -- y la que se usa aquí -- es emitir el salto con un
 * desplazamiento provisional de 0, anotar un "fixup", y rellenarlo cuando la
 * etiqueta se define. `finish()` verifica que no quede ningún fixup sin
 * resolver, así que un bug de compilación se convierte en una excepción y no en
 * bytecode que salta a un sitio arbitrario.
 *
 * Además lleva la cuenta de la PROFUNDIDAD DE PILA de forma estática. Eso es lo
 * que permite decirle a un niño "tienes demasiados bloques metidos unos dentro
 * de otros" en pantalla, en vez de que el robot se congele en el aula sin que
 * nadie sepa por qué.
 */

const {OPCODES, OPERANDS, OPERAND_SIZES, instructionSize} = require('./isa');

class Emitter {
    /**
     * @param {object} [options] Opciones.
     * @param {number} [options.maxStackDepth] Tope de profundidad de pila.
     * @param {number} [options.maxLoopDepth] Tope de anidamiento de bucles.
     */
    constructor (options) {
        const opts = options || {};

        /** @type {Array.<number>} Bytes emitidos. */
        this.bytes = [];

        /** @type {Object.<string, number>} Etiqueta -> dirección. */
        this._labels = {};

        /**
         * Saltos pendientes de resolver.
         * @type {Array.<{label: string, at: number, nextPc: number}>}
         */
        this._fixups = [];

        this._nextLabelId = 0;

        /** Profundidad de pila simulada durante la emisión. */
        this._stackDepth = 0;
        /** Máximo alcanzado (lo que hay que comparar con el límite). */
        this.maxStackReached = 0;
        this._maxStackDepth = typeof opts.maxStackDepth === 'number' ? opts.maxStackDepth : 16;

        /** Profundidad de anidamiento de bucles. */
        this._loopDepth = 0;
        this.maxLoopReached = 0;
        this._maxLoopDepth = typeof opts.maxLoopDepth === 'number' ? opts.maxLoopDepth : 8;
    }

    /** @returns {number} Dirección actual (dónde caería el siguiente byte). */
    get pc () {
        return this.bytes.length;
    }

    /**
     * Crea una etiqueta única todavía sin ubicar.
     * @param {string} [hint] Pista legible para depurar.
     * @returns {string} Nombre de la etiqueta.
     */
    label (hint) {
        return `${hint || 'L'}_${this._nextLabelId++}`;
    }

    /**
     * Fija una etiqueta en la posición actual y resuelve los saltos que la
     * esperaban.
     * @param {string} name Etiqueta creada con `label()`.
     */
    place (name) {
        if (Object.prototype.hasOwnProperty.call(this._labels, name)) {
            throw new Error(`La etiqueta "${name}" ya fue ubicada`);
        }
        this._labels[name] = this.pc;
    }

    // -- Escritura de tipos primitivos (little-endian) ------------------------

    /**
     * @param {number} value Byte a escribir.
     * @returns {Emitter} this
     */
    writeU8 (value) {
        this.bytes.push(value & 0xFF);
        return this;
    }

    /**
     * @param {number} value Entero de 16 bits.
     * @returns {Emitter} this
     */
    writeU16 (value) {
        this.bytes.push(value & 0xFF, (value >> 8) & 0xFF);
        return this;
    }

    /**
     * @param {number} value Float de 32 bits.
     * @returns {Emitter} this
     */
    writeF32 (value) {
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setFloat32(0, value, true);
        const view = new Uint8Array(buffer);
        this.bytes.push(view[0], view[1], view[2], view[3]);
        return this;
    }

    // -- Emisión de instrucciones -------------------------------------------

    /**
     * Emite una instrucción con sus operandos inmediatos, y ajusta la
     * profundidad de pila simulada.
     * @param {string} name Nombre del opcode (clave de OPCODES).
     * @param {Array.<number>} [operands] Operandos inmediatos.
     * @param {number} [stackDelta] Cambio neto en la pila (pops negativos +
     *     pushes). Si se omite, no se toca la profundidad.
     * @returns {Emitter} this
     */
    emit (name, operands, stackDelta) {
        const opcode = OPCODES[name];
        if (typeof opcode !== 'number') {
            throw new Error(`Opcode desconocido: ${name}`);
        }

        this.writeU8(opcode);

        const kinds = OPERANDS[name] || [];
        const values = operands || [];
        if (kinds.length !== values.length) {
            throw new Error(
                `${name} espera ${kinds.length} operando(s) y recibió ${values.length}`
            );
        }
        for (let i = 0; i < kinds.length; i++) {
            switch (kinds[i]) {
            case 'u8':
            case 'i8':
                this.writeU8(values[i]);
                break;
            case 'u16':
            case 'i16':
                this.writeU16(values[i]);
                break;
            case 'f32':
                this.writeF32(values[i]);
                break;
            default:
                throw new Error(`Tipo de operando desconocido: ${kinds[i]}`);
            }
        }

        if (typeof stackDelta === 'number') this.adjustStack(stackDelta);
        return this;
    }

    /**
     * Emite un salto hacia una etiqueta que puede no existir todavía.
     * El desplazamiento es relativo al PC de la instrucción SIGUIENTE.
     * @param {string} name Opcode de salto (JMP, JZ, JNZ, LOOP_TEST, LOOP_NEXT).
     * @param {string} labelName Etiqueta destino.
     * @param {number} [stackDelta] Cambio en la pila (JZ/JNZ consumen 1).
     * @returns {Emitter} this
     */
    emitJump (name, labelName, stackDelta) {
        const operandAt = this.pc + 1; // justo después del byte de opcode
        const nextPc = this.pc + instructionSize(name);

        this.emit(name, [0], stackDelta); // desplazamiento provisional
        this._fixups.push({label: labelName, at: operandAt, nextPc});
        return this;
    }

    // -- Contabilidad de pila y bucles ---------------------------------------

    /**
     * Ajusta la profundidad de pila simulada y vigila el tope.
     * @param {number} delta Cambio neto.
     */
    adjustStack (delta) {
        this._stackDepth += delta;
        if (this._stackDepth < 0) {
            // Sólo puede pasar por un bug del compilador, no por un programa
            // mal hecho del usuario: mejor romper ruidosamente.
            throw new Error('Desbordamiento por abajo de la pila al compilar (bug del compilador)');
        }
        if (this._stackDepth > this.maxStackReached) {
            this.maxStackReached = this._stackDepth;
        }
    }

    /** @returns {boolean} True si se excedió el tope de pila. */
    stackOverflowed () {
        return this.maxStackReached > this._maxStackDepth;
    }

    /** Marca la entrada a un bucle (para vigilar el anidamiento). */
    enterLoop () {
        this._loopDepth++;
        if (this._loopDepth > this.maxLoopReached) {
            this.maxLoopReached = this._loopDepth;
        }
    }

    /** Marca la salida de un bucle. */
    exitLoop () {
        this._loopDepth--;
    }

    /** @returns {boolean} True si se excedió el anidamiento de bucles. */
    loopOverflowed () {
        return this.maxLoopReached > this._maxLoopDepth;
    }

    /**
     * Reinicia la profundidad de pila. Se llama al empezar cada hilo: los
     * hilos no comparten pila.
     */
    resetStack () {
        this._stackDepth = 0;
    }

    // -- Cierre --------------------------------------------------------------

    /**
     * Resuelve todos los saltos pendientes y devuelve el código final.
     * @returns {Uint8Array} Bytes del código máquina.
     */
    finish () {
        for (const fixup of this._fixups) {
            const target = this._labels[fixup.label];
            if (typeof target !== 'number') {
                throw new Error(`Etiqueta sin ubicar: "${fixup.label}" (bug del compilador)`);
            }
            const offset = target - fixup.nextPc;
            if (offset < -32768 || offset > 32767) {
                // Inalcanzable en la práctica: el límite de tamaño de programa
                // corta mucho antes. Se comprueba igual porque un salto
                // truncado sería casi imposible de diagnosticar.
                throw new Error(`Salto fuera de rango (${offset}) hacia "${fixup.label}"`);
            }
            this.bytes[fixup.at] = offset & 0xFF;
            this.bytes[fixup.at + 1] = (offset >> 8) & 0xFF;
        }
        this._fixups = [];
        return Uint8Array.from(this.bytes);
    }
}

module.exports = Emitter;
module.exports.OPERAND_SIZES = OPERAND_SIZES;
