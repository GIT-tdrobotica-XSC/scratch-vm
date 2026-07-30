/**
 * El compilador: recorre los bloques de un target y emite bytecode.
 *
 * La forma del recorrido es la misma que la de `Blocks.blockToXML()`
 * (engine/blocks.js:1245): bajar por `next` para las sentencias en secuencia,
 * por `getBranch()` para los cuerpos de los bloques en C, y por los `inputs`
 * para las expresiones.
 *
 * INVARIANTES QUE SOSTIENEN TODO:
 *   - Una expresión deja exactamente 1 valor en la pila.
 *   - Una sentencia deja la pila como la encontró.
 *   - Todo arco de retorno de un bucle va precedido de YIELD, para que un
 *     `por siempre` sin esperas no congele la placa.
 */

const {OPCODES, STOP_MODES, HAT_KINDS} = require('./isa');
const Emitter = require('./emitter');
const {CompileError, ErrorCode, WarningCode, unsupportedBlockError, warning} = require('./errors');
const {compileOperator, compileDataStatement} = require('./compile-operators');
const {compileDeviceBlock, pushNumber} = require('./compile-device');

/** Bloques literales (sombras) y su field portador del valor. */
const LITERAL_FIELDS = {
    math_number: 'NUM',
    math_integer: 'NUM',
    math_whole_number: 'NUM',
    math_positive_number: 'NUM',
    math_angle: 'NUM',
    text: 'TEXT',
    colour_picker: 'COLOUR'
};

/** Sombrero soportado -> tipo de hilo. */
const SUPPORTED_HATS = {
    event_whenflagclicked: HAT_KINDS.whenFlagClicked
};

/** Bloques que se ignoran con un aviso, en vez de romper la subida. */
const HARMLESS_NO_OPS = {
    data_showvariable: 'mostrar una variable en pantalla',
    data_hidevariable: 'esconder una variable',
    looks_hide: 'esconder el objeto',
    looks_show: 'mostrar el objeto'
};

class Compiler {
    /**
     * @param {object} blocks Contenedor `Blocks` del target.
     * @param {object} target Descriptor de la placa (`{HW, BLOCKS, boardId}`).
     * @param {object} limits Límites de la placa.
     */
    constructor (blocks, target, limits) {
        this.blocks = blocks;
        this.target = target;
        this.limits = limits;

        this.emitter = new Emitter({
            maxStackDepth: limits.maxStackDepth,
            maxLoopDepth: limits.maxLoopDepth
        });

        /** Errores acumulados: se reportan TODOS, no sólo el primero. */
        this.errors = [];
        this.warnings = [];

        /** Nombre de variable -> slot. */
        this._varSlots = new Map();
        /** Texto -> índice en la tabla de strings. */
        this._stringSlots = new Map();
        this._strings = [];
        /** Slots reservados al final para temporales del compilador. */
        this._tempSlots = [];
    }

    // ── Utilidades ───────────────────────────────────────────────────────

    /**
     * Registra un error y sigue compilando, para poder reportarlos todos de
     * una vez.
     * @param {CompileError} error El error.
     */
    fail (error) {
        // No repetir el mismo bloque dos veces (un reporter dentro de un bucle
        // se visita una sola vez, pero por si acaso).
        if (!this.errors.some(e => e.blockId === error.blockId && e.code === error.code)) {
            this.errors.push(error);
        }
    }

    /**
     * @param {object} block Bloque.
     * @param {string} name Nombre del field.
     * @returns {string|null} Valor del field, o null si no existe.
     */
    fieldValue (block, name) {
        if (block.fields && block.fields[name]) return block.fields[name].value;
        // Un menú con `acceptReporters: true` llega como input con un bloque
        // sombra `<ext>_menu_<menu>`; su valor está en el field de la sombra.
        if (block.inputs && block.inputs[name]) {
            const shadowId = block.inputs[name].shadow || block.inputs[name].block;
            const shadow = shadowId && this.blocks.getBlock(shadowId);
            if (shadow && shadow.fields) {
                const first = Object.keys(shadow.fields)[0];
                if (first) return shadow.fields[first].value;
            }
        }
        return null;
    }

    /**
     * Slot de una variable, creándolo la primera vez que se ve.
     * @param {object} field Field `VARIABLE` (`{id, value}`).
     * @returns {number} Índice de slot.
     */
    variableSlot (field) {
        const key = (field && (field.id || field.value)) || 'sin-nombre';
        if (!this._varSlots.has(key)) {
            if (this._varSlots.size >= this.limits.maxVars) {
                this.fail(new CompileError(
                    ErrorCode.TOO_MANY_VARS,
                    `Tu programa usa demasiadas variables: el robot sólo puede ` +
                    `recordar ${this.limits.maxVars} a la vez.`
                ));
                return 0;
            }
            this._varSlots.set(key, this._varSlots.size);
        }
        return this._varSlots.get(key);
    }

    /**
     * Reserva un slot temporal para uso interno del compilador.
     * @returns {number} Índice de slot.
     */
    tempSlot () {
        const key = `__tmp${this._tempSlots.length}`;
        if (!this._varSlots.has(key)) {
            this._varSlots.set(key, this._varSlots.size);
            this._tempSlots.push(key);
        }
        return this._varSlots.get(key);
    }

    /**
     * Índice de un texto en la tabla de strings, deduplicando.
     * @param {string} text Texto.
     * @returns {number} Índice.
     */
    stringSlot (text) {
        if (!this._stringSlots.has(text)) {
            if (this._strings.length >= this.limits.maxStrings) {
                this.fail(new CompileError(
                    ErrorCode.TOO_MANY_STRINGS,
                    'Tu programa usa demasiados textos distintos para la memoria del robot.'
                ));
                return 0;
            }
            this._stringSlots.set(text, this._strings.length);
            this._strings.push(text);
        }
        return this._stringSlots.get(text);
    }

    // ── Expresiones ──────────────────────────────────────────────────────

    /**
     * Compila la expresión conectada a un input, dejando 1 valor en la pila.
     * Si el input está vacío, empuja 0 (como hace Scratch).
     *
     * @param {object} block Bloque padre.
     * @param {string} inputName Nombre del input.
     */
    expression (block, inputName) {
        const input = block.inputs && block.inputs[inputName];
        if (!input) {
            // Input vacío: Scratch lo trata como 0/"".
            this.emitter.emit('PUSH_I8', [0], 1);
            return;
        }

        // `block` es el valor conectado; `shadow` es el literal de debajo. Si
        // hay un reporter encima, `block` !== `shadow` y manda el reporter.
        const valueId = input.block || input.shadow;
        const valueBlock = valueId && this.blocks.getBlock(valueId);
        if (!valueBlock) {
            this.emitter.emit('PUSH_I8', [0], 1);
            return;
        }

        this.expressionBlock(valueBlock);
    }

    /**
     * Compila un bloque usado como expresión.
     * @param {object} block Bloque.
     */
    expressionBlock (block) {
        const e = this.emitter;

        // Literales y sombras.
        const literalField = LITERAL_FIELDS[block.opcode];
        if (literalField) {
            const raw = block.fields[literalField] ? block.fields[literalField].value : 0;
            this.pushLiteral(raw, block.opcode);
            return;
        }

        // Menús de la extensión: `<ext>_menu_<nombre>`.
        if (/_menu_/.test(block.opcode)) {
            const first = block.fields && Object.keys(block.fields)[0];
            this.pushLiteral(first ? block.fields[first].value : 0, block.opcode);
            return;
        }

        if (compileOperator(this, block)) return;
        if (compileDeviceBlock(this, block, true)) return;

        this.fail(unsupportedBlockError(block));
        // Se empuja algo para no romper la invariante de pila y poder seguir
        // buscando más errores en el resto del programa.
        e.emit('PUSH_I8', [0], 1);
    }

    /**
     * Empuja un literal, eligiendo número o texto.
     * @param {*} raw Valor crudo del field.
     * @param {string} opcode Opcode de origen (para decidir el tipo).
     */
    pushLiteral (raw, opcode) {
        const e = this.emitter;
        // Los colores son textos '#rrggbb' que sólo tienen sentido plegados;
        // si llegan aquí como expresión suelta, van como texto.
        const isTextual = opcode === 'text' || opcode === 'colour_picker';
        const n = Number(raw);
        if (!isTextual && raw !== '' && !isNaN(n)) {
            pushNumber(e, n);
        } else {
            e.emit('PUSH_STR', [this.stringSlot(String(raw))], 1);
        }
    }

    // ── Sentencias ───────────────────────────────────────────────────────

    /**
     * Compila una cadena de sentencias siguiendo los `next`.
     * @param {string|null} firstId Id del primer bloque, o null.
     */
    statements (firstId) {
        let id = firstId;
        while (id) {
            const block = this.blocks.getBlock(id);
            if (!block) break;
            const stop = this.statement(block);
            if (stop) {
                // Tras un `por siempre` o un `detener`, lo que siga es
                // inalcanzable. Se avisa una vez y no se compila.
                const next = this.blocks.getNextBlock(id);
                if (next) {
                    this.warnings.push(warning(
                        WarningCode.UNREACHABLE,
                        'Los bloques que pusiste después de "por siempre" nunca se van a ejecutar.',
                        next
                    ));
                }
                return;
            }
            id = this.blocks.getNextBlock(id);
        }
    }

    /**
     * Compila una sentencia.
     * @param {object} block Bloque.
     * @returns {boolean} True si el flujo no continúa tras este bloque.
     */
    statement (block) {
        const e = this.emitter;
        const {opcode} = block;

        if (HARMLESS_NO_OPS[opcode]) {
            this.warnings.push(warning(
                WarningCode.NO_EFFECT,
                `El bloque para ${HARMLESS_NO_OPS[opcode]} no hace nada en el robot, ` +
                `pero no estorba.`,
                block.id
            ));
            return false;
        }

        switch (opcode) {
        case 'control_forever': {
            const top = e.label('forever');
            e.enterLoop();
            e.place(top);
            this.statements(this.blocks.getBranch(block.id, 1));
            e.emit('YIELD');
            e.emitJump('JMP', top);
            e.exitLoop();
            return true; // nada después de un `por siempre` se ejecuta
        }

        case 'control_repeat': {
            const body = e.label('repeatBody');
            const done = e.label('repeatDone');
            this.expression(block, 'TIMES');
            e.emit('REPEAT_SETUP', [], -1);
            e.enterLoop();
            e.place(body);
            e.emitJump('LOOP_TEST', done);
            this.statements(this.blocks.getBranch(block.id, 1));
            e.emit('YIELD');
            e.emitJump('LOOP_NEXT', body);
            e.place(done);
            e.exitLoop();
            return false;
        }

        case 'control_repeat_until':
        case 'control_while': {
            const top = e.label('whileTop');
            const done = e.label('whileDone');
            e.enterLoop();
            e.place(top);
            this.booleanExpression(block, 'CONDITION');
            // `repetir hasta` sale cuando la condición se cumple;
            // `mientras` (oculto) sale cuando deja de cumplirse.
            e.emitJump(opcode === 'control_while' ? 'JZ' : 'JNZ', done, -1);
            this.statements(this.blocks.getBranch(block.id, 1));
            e.emit('YIELD');
            e.emitJump('JMP', top);
            e.place(done);
            e.exitLoop();
            return false;
        }

        case 'control_if': {
            const done = e.label('ifDone');
            this.booleanExpression(block, 'CONDITION');
            e.emitJump('JZ', done, -1);
            this.statements(this.blocks.getBranch(block.id, 1));
            e.place(done);
            return false;
        }

        case 'control_if_else': {
            const otherwise = e.label('else');
            const done = e.label('ifElseDone');
            this.booleanExpression(block, 'CONDITION');
            e.emitJump('JZ', otherwise, -1);
            this.statements(this.blocks.getBranch(block.id, 1));
            e.emitJump('JMP', done);
            e.place(otherwise);
            // Ojo: getBranch() es 1-based, no 0-based. La segunda rama es la 2;
            // pedir la 0 o la 1 devuelve la MISMA (el input SUBSTACK).
            this.statements(this.blocks.getBranch(block.id, 2));
            e.place(done);
            return false;
        }

        case 'control_wait': {
            this.expression(block, 'DURATION');
            e.emit('WAIT', [], -1);
            return false;
        }

        case 'control_wait_until': {
            const top = e.label('waitUntil');
            const done = e.label('waitUntilDone');
            e.place(top);
            this.booleanExpression(block, 'CONDITION');
            e.emitJump('JNZ', done, -1);
            e.emit('YIELD');
            e.emitJump('JMP', top);
            e.place(done);
            return false;
        }

        case 'control_stop': {
            const option = this.fieldValue(block, 'STOP_OPTION');
            const mode = typeof STOP_MODES[option] === 'number' ?
                STOP_MODES[option] : STOP_MODES.all;
            e.emit('STOP', [mode]);
            // "detener otros scripts" no corta este hilo.
            return mode !== STOP_MODES['other scripts in sprite'];
        }

        default:
            break;
        }

        if (compileDataStatement(this, block)) return false;
        if (compileDeviceBlock(this, block, false)) return false;

        this.fail(unsupportedBlockError(block));
        return false;
    }

    /**
     * Compila una condición. Un hueco vacío vale "falso", como en Scratch.
     * @param {object} block Bloque padre.
     * @param {string} inputName Nombre del input.
     */
    booleanExpression (block, inputName) {
        const input = block.inputs && block.inputs[inputName];
        if (!input || !(input.block || input.shadow)) {
            this.emitter.emit('PUSH_FALSE', [], 1);
            return;
        }
        this.expression(block, inputName);
    }

    // ── Programa completo ────────────────────────────────────────────────

    /**
     * Compila todos los scripts del target.
     * @returns {object} `{code, threads, strings, numVars}`.
     */
    compile () {
        const e = this.emitter;
        const threads = [];

        for (const scriptId of this.blocks.getScripts()) {
            const hat = this.blocks.getBlock(scriptId);
            if (!hat) continue;

            const hatKind = SUPPORTED_HATS[hat.opcode];

            if (typeof hatKind === 'undefined') {
                // Un bloque suelto (sin sombrero) no es un error: en Scratch
                // tampoco se ejecuta solo. Se avisa y se ignora.
                if (!/^(event_|control_start_as_clone)/.test(hat.opcode)) {
                    this.warnings.push(warning(
                        WarningCode.ORPHAN_SCRIPT,
                        'Tienes bloques sueltos que no empiezan con "al presionar la bandera ' +
                        'verde", así que el robot no sabría cuándo ejecutarlos.',
                        hat.id
                    ));
                    continue;
                }
                // Un sombrero de otro tipo (tecla, mensaje...) sí es un error
                // accionable: el niño quiso que algo pasara.
                this.fail(unsupportedBlockError(hat));
                continue;
            }

            if (threads.length >= this.limits.maxThreads) {
                this.fail(new CompileError(
                    ErrorCode.TOO_MANY_THREADS,
                    `Tu programa tiene más banderas verdes de las que el robot puede ` +
                    `correr a la vez (máximo ${this.limits.maxThreads}).`,
                    {blockId: hat.id, opcode: hat.opcode}
                ));
                continue;
            }

            e.resetStack();
            const entryPc = e.pc;
            this.statements(this.blocks.getNextBlock(scriptId));
            e.emit('HALT');
            threads.push({hatKind, entryPc});
        }

        if (threads.length === 0 && this.errors.length === 0) {
            this.fail(new CompileError(
                ErrorCode.NO_HAT,
                'No hay nada que subir: tu programa necesita al menos un bloque ' +
                '"al presionar la bandera verde" con bloques debajo.',
                {hint: 'La bandera verde es el botón de encendido de tu robot.'}
            ));
        }

        const code = e.finish();

        // Comprobaciones de límites que sólo se pueden hacer al final.
        if (e.stackOverflowed()) {
            this.fail(new CompileError(
                ErrorCode.STACK_TOO_DEEP,
                'Tienes bloques de operaciones metidos unos dentro de otros demasiadas veces.',
                {hint: 'Guarda algún resultado intermedio en una variable para simplificar.'}
            ));
        }
        if (e.loopOverflowed()) {
            this.fail(new CompileError(
                ErrorCode.LOOPS_TOO_DEEP,
                'Tienes demasiados bucles uno dentro de otro.'
            ));
        }
        if (code.length > this.limits.maxCodeSize) {
            this.fail(new CompileError(
                ErrorCode.PROGRAM_TOO_BIG,
                `Tu programa es muy grande para la memoria del robot ` +
                `(${code.length} de ${this.limits.maxCodeSize} bytes).`,
                {hint: 'Prueba usando "repetir" en vez de copiar los mismos bloques varias veces.'}
            ));
        }

        return {
            code,
            threads,
            strings: this._strings,
            numVars: this._varSlots.size,
            maxStack: e.maxStackReached,
            maxLoopDepth: e.maxLoopReached
        };
    }
}

module.exports = Compiler;
module.exports.LITERAL_FIELDS = LITERAL_FIELDS;
module.exports.SUPPORTED_HATS = SUPPORTED_HATS;
module.exports.OPCODES = OPCODES;
