/**
 * Compilación de los bloques de la extensión del dispositivo a `CALL_HW`.
 *
 * Lee el descriptor declarativo de la placa (`targets/<placa>/blocks-map.js`) y
 * emite: los argumentos en orden, la llamada, y las operaciones posteriores
 * (`post`) cuando el reporter necesita ajustarse.
 */

/**
 * Instrucciones que sustituyen el tope de la pila en vez de consumir dos
 * valores. Distinguirlas importa: contar `ROUND` como binaria descuadra la
 * cuenta estática de profundidad y el emisor aborta creyendo que hay un bug.
 */
const UNARY_OPS = new Set(['ROUND', 'NOT', 'LENGTH', 'MATHOP']);

/**
 * Saldo de pila de un paso de `post`.
 * @param {string} op Nombre del opcode.
 * @returns {number} Cambio neto en la profundidad.
 */
const postStackDelta = function (op) {
    if (op === 'PUSH_I8' || op === 'PUSH_F32' || op === 'PUSH_STR') return 1;
    if (UNARY_OPS.has(op)) return 0;
    return -1;
};

/**
 * Empuja un número usando la codificación más corta posible: 2 bytes en vez de
 * 5 para los enteros pequeños, que son la gran mayoría de los literales de un
 * programa infantil (0, 1, 50, 100...).
 * @param {object} e Emisor.
 * @param {number} value Valor.
 */
const pushNumber = function (e, value) {
    if (Number.isInteger(value) && value >= -128 && value <= 127) {
        e.emit('PUSH_I8', [value], 1);
    } else {
        e.emit('PUSH_F32', [value], 1);
    }
};

/**
 * Acota el valor que está en el tope de la pila, dejándolo acotado.
 *
 * Se emite como bytecode (comparación + salto) porque la ISA no tiene una
 * instrucción de acotado, y no vale la pena añadir una por esto.
 *
 * @param {object} e Emisor.
 * @param {number|null} min Mínimo, o null si no hay.
 * @param {number|null} max Máximo, o null si no hay.
 */
const emitClamp = function (e, min, max) {
    if (typeof min === 'number') {
        const skip = e.label('clampMin');
        e.emit('DUP', [], 1);
        pushNumber(e, min);
        e.emit('LT', [], -1); // ¿x < min?
        e.emitJump('JZ', skip, -1);
        e.emit('POP', [], -1);
        pushNumber(e, min);
        e.place(skip);
    }
    if (typeof max === 'number') {
        const skip = e.label('clampMax');
        e.emit('DUP', [], 1);
        pushNumber(e, max);
        e.emit('GT', [], -1); // ¿x > max?
        e.emitJump('JZ', skip, -1);
        e.emit('POP', [], -1);
        pushNumber(e, max);
        e.place(skip);
    }
};

/**
 * Aplica los modificadores de un argumento (`clamp`, `min`, `max`, `coerce`)
 * al valor que ya está en la pila.
 *
 * Son las MISMAS acotaciones que hace hoy el handler de JS
 * (`Math.max(-100, Math.min(100, ...))`). Si no se emitieran, un niño que
 * escribe "motores 500%" vería un comportamiento distinto con el robot
 * autónomo que con el robot conectado: justo la clase de divergencia
 * silenciosa que este diseño tiene que evitar.
 *
 * @param {object} e Emisor.
 * @param {object} arg Descriptor del argumento.
 */
const applyModifiers = function (e, arg) {
    if (arg.clamp) emitClamp(e, arg.clamp[0], arg.clamp[1]);
    if (typeof arg.min === 'number') emitClamp(e, arg.min, null);
    if (typeof arg.max === 'number') emitClamp(e, null, arg.max);
    if (arg.coerce === 'int') e.emit('ROUND', [], 0);
};

/**
 * Compila un único argumento de una primitiva, dejándolo en la pila.
 *
 * @param {object} compiler Compilador.
 * @param {object} block Bloque.
 * @param {object} arg Descriptor del argumento.
 */
const compileArgument = function (compiler, block, arg) {
    const e = compiler.emitter;

    // Constante literal.
    if (typeof arg.value === 'number') {
        pushNumber(e, arg.value);
        return;
    }

    // Constante calculada plegando uno o más fields (colores, notas...).
    if (typeof arg.fold === 'function') {
        const helpers = {field: (b, name) => compiler.fieldValue(b, name)};
        const folded = arg.fold(block, helpers);
        if (typeof folded === 'string') {
            e.emit('PUSH_STR', [compiler.stringSlot(folded)], 1);
        } else {
            pushNumber(e, folded);
        }
        return;
    }

    // Field: un menú fijo, resuelto en tiempo de compilación.
    if (arg.field) {
        const raw = compiler.fieldValue(block, arg.field);
        if (arg.map) {
            const mapped = arg.map[raw];
            pushNumber(e, typeof mapped === 'number' ? mapped : arg.fallback);
        } else if (arg.coerce === 'string') {
            e.emit('PUSH_STR', [compiler.stringSlot(String(raw))], 1);
        } else {
            const n = Number(raw);
            pushNumber(e, isNaN(n) ? 0 : n);
        }
        return;
    }

    // Input: una expresión, que puede ser un literal, un menú con sombra o un
    // reporter de verdad.
    compiler.expression(block, arg.input);
    applyModifiers(e, arg);
};

/**
 * Compila un bloque de la extensión del dispositivo.
 *
 * @param {object} compiler Compilador.
 * @param {object} block Bloque.
 * @param {boolean} asExpression True si se usa como reporter (debe dejar un
 *     valor en la pila).
 * @returns {boolean} True si el bloque pertenece a esta placa y se compiló.
 */
const compileDeviceBlock = function (compiler, block, asExpression) {
    const spec = compiler.target.BLOCKS[block.opcode];
    if (!spec) return false;

    const e = compiler.emitter;
    const hw = compiler.target.HW[spec.hw];

    // `wait: 'arg:N'` significa "tras llamar, espera los milisegundos del
    // argumento N". Ese argumento puede ser una expresión con efectos (leer un
    // sensor), así que NO puede compilarse dos veces: se guarda en un temporal,
    // se usa para la llamada y se reutiliza para la espera.
    let waitSlot = null;
    let waitArgIndex = -1;
    if (spec.wait && spec.wait.startsWith('arg:')) {
        waitArgIndex = parseInt(spec.wait.slice(4), 10);
        waitSlot = compiler.tempSlot();
        compileArgument(compiler, block, spec.args[waitArgIndex]);
        e.emit('STORE_VAR', [waitSlot], -1);
    }

    // Argumentos, en el orden que espera la primitiva.
    for (let i = 0; i < spec.args.length; i++) {
        if (i === waitArgIndex) {
            e.emit('LOAD_VAR', [waitSlot], 1);
        } else {
            compileArgument(compiler, block, spec.args[i]);
        }
    }

    const opName = hw.kind === 'wait' ? 'CALL_HW_WAIT' :
        ((asExpression || hw.kind === 'reporter') ? 'CALL_HW_R' : 'CALL_HW');
    const delta = opName === 'CALL_HW_R' ? (1 - hw.argc) : -hw.argc;
    e.emit(opName, [hw.id, hw.argc], delta);

    if (spec.post && opName === 'CALL_HW_R') {
        for (const step of spec.post) {
            e.emit(step.op, step.operands || [], postStackDelta(step.op));
        }
    }

    if (waitSlot !== null) {
        e.emit('LOAD_VAR', [waitSlot], 1);
        e.emit('PUSH_F32', [1000], 1);
        e.emit('DIV', [], -1);
        e.emit('WAIT', [], -1);
    }

    return true;
};

module.exports = {
    compileDeviceBlock,
    compileArgument,
    pushNumber,
    emitClamp,
    postStackDelta
};
