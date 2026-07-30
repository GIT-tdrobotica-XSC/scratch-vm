/**
 * Compilación de EXPRESIONES: operadores, variables y literales.
 *
 * Todo lo de aquí deja exactamente UN valor en la pila. Esa invariante es lo
 * que permite al emisor llevar la cuenta estática de la profundidad y avisar
 * "tienes demasiados bloques metidos unos dentro de otros" antes de subir,
 * en vez de que el robot se congele en el aula.
 */

const {MATHOP_FUNCTIONS} = require('./isa');

/**
 * Operadores binarios que se traducen a un único opcode. Los dos operandos se
 * empujan en orden (izquierdo, derecho) y la instrucción los consume.
 * @type {Object.<string, {op: string, args: Array.<string>}>}
 */
const BINARY_OPS = {
    operator_add: {op: 'ADD', args: ['NUM1', 'NUM2']},
    operator_subtract: {op: 'SUB', args: ['NUM1', 'NUM2']},
    operator_multiply: {op: 'MUL', args: ['NUM1', 'NUM2']},
    operator_divide: {op: 'DIV', args: ['NUM1', 'NUM2']},
    operator_mod: {op: 'MOD', args: ['NUM1', 'NUM2']},
    operator_random: {op: 'RANDOM', args: ['FROM', 'TO']},
    operator_lt: {op: 'LT', args: ['OPERAND1', 'OPERAND2']},
    operator_equals: {op: 'EQ', args: ['OPERAND1', 'OPERAND2']},
    operator_gt: {op: 'GT', args: ['OPERAND1', 'OPERAND2']},
    operator_and: {op: 'AND', args: ['OPERAND1', 'OPERAND2']},
    operator_or: {op: 'OR', args: ['OPERAND1', 'OPERAND2']},
    operator_join: {op: 'JOIN', args: ['STRING1', 'STRING2']},
    operator_letter_of: {op: 'LETTER_OF', args: ['LETTER', 'STRING']},
    operator_contains: {op: 'CONTAINS', args: ['STRING1', 'STRING2']}
};

/** Operadores unarios. */
const UNARY_OPS = {
    operator_not: {op: 'NOT', arg: 'OPERAND'},
    operator_round: {op: 'ROUND', arg: 'NUM'},
    operator_length: {op: 'LENGTH', arg: 'STRING'}
};

/**
 * Intenta compilar un bloque como expresión de operador o de datos.
 *
 * @param {object} compiler Compilador (provee `emitter`, `expression()`,
 *     `pushLiteral()`, `variableSlot()`, `fail()`).
 * @param {object} block Bloque a compilar.
 * @returns {boolean} True si se reconoció y compiló; false si no es de aquí.
 */
const compileOperator = function (compiler, block) {
    const {opcode} = block;
    const e = compiler.emitter;

    const binary = BINARY_OPS[opcode];
    if (binary) {
        compiler.expression(block, binary.args[0]);
        compiler.expression(block, binary.args[1]);
        // Dos entradas -> una salida: la pila baja en 1.
        e.emit(binary.op, [], -1);
        return true;
    }

    const unary = UNARY_OPS[opcode];
    if (unary) {
        compiler.expression(block, unary.arg);
        e.emit(unary.op, [], 0);
        return true;
    }

    switch (opcode) {
    case 'operator_mathop': {
        const fn = compiler.fieldValue(block, 'OPERATOR');
        const index = MATHOP_FUNCTIONS.indexOf(fn);
        compiler.expression(block, 'NUM');
        // Una función desconocida daría 0 en el intérprete; es mejor que
        // fallar la subida entera por un menú que Scratch no debería producir.
        e.emit('MATHOP', [index < 0 ? 0 : index], 0);
        return true;
    }

    case 'data_variable': {
        const slot = compiler.variableSlot(block.fields.VARIABLE);
        e.emit('LOAD_VAR', [slot], 1);
        return true;
    }

    case 'sensing_timer':
        e.emit('TIMER', [], 1);
        return true;

    default:
        return false;
    }
};

/**
 * Intenta compilar un bloque como SENTENCIA de datos (asignar/cambiar
 * variable). Las de aquí no dejan nada en la pila.
 *
 * @param {object} compiler Compilador.
 * @param {object} block Bloque.
 * @returns {boolean} True si se reconoció y compiló.
 */
const compileDataStatement = function (compiler, block) {
    const e = compiler.emitter;

    switch (block.opcode) {
    case 'data_setvariableto': {
        const slot = compiler.variableSlot(block.fields.VARIABLE);
        compiler.expression(block, 'VALUE');
        e.emit('STORE_VAR', [slot], -1);
        return true;
    }

    case 'data_changevariableby': {
        const slot = compiler.variableSlot(block.fields.VARIABLE);
        compiler.expression(block, 'VALUE');
        // CHANGE_VAR hace el `var = var + delta` en una sola instrucción, en
        // vez de LOAD/ADD/STORE: es lo que más se repite en los programas de
        // contadores y ahorra dos bytes por uso.
        e.emit('CHANGE_VAR', [slot], -1);
        return true;
    }

    case 'sensing_resettimer':
        e.emit('TIMER_RESET', []);
        return true;

    default:
        return false;
    }
};

module.exports = {
    BINARY_OPS,
    UNARY_OPS,
    compileOperator,
    compileDataStatement
};
