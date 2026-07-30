/**
 * Intérprete de referencia del bytecode de PlayCode, en JS.
 *
 * Cumple TRES funciones a la vez, y por eso vale la pena que exista:
 *
 *   1. **Oráculo de tests del compilador.** Se compila un programa y se
 *      comprueba qué haría el robot, sin robot.
 *   2. **Especificación EJECUTABLE del firmware.** Quien escriba `vm.cpp`
 *      porta este archivo: cada opcode tiene aquí su semántica exacta y un
 *      test que la fija. Es mucho más difícil de malinterpretar que un
 *      documento en prosa.
 *   3. Base de un futuro simulador dentro del editor ("ver qué haría tu
 *      robot" sin tener la placa a mano).
 *
 * **Reloj virtual:** `WAIT` no espera de verdad, adelanta un contador. Un
 * programa que en el robot dura 10 minutos se simula en milisegundos, y de
 * forma determinista: sin timers reales no hay tests intermitentes.
 *
 * El planificador replica el que llevará el firmware (round-robin cooperativo,
 * mismos puntos de cesión), porque su comportamiento es observable: dos
 * `por siempre` en paralelo intercalan de una manera concreta y los tests la
 * fijan.
 */

const {OPCODES, OPCODE_NAMES, MATHOP_FUNCTIONS, STOP_MODES, RUNTIME_ERRORS} = require('../isa');
const {parseProgram} = require('../serialize');
const V = require('./values');

/** Estados de un hilo. Espejo de los del firmware. */
const STATUS = {
    RUNNING: 0,
    YIELD_TICK: 1,
    WAIT_TIMER: 2,
    WAIT_HW: 3,
    DONE: 4
};

/** Presupuesto de instrucciones por hilo y ronda (igual que en el firmware). */
const INSTR_BUDGET = 200;

/**
 * Milisegundos que avanza el reloj por cada ronda en la que algún hilo corrió.
 * Modela lo que tarda una pasada del `loop()` del firmware (VM_SLICE_MS).
 *
 * No es un detalle cosmético: sin esto, un `esperar hasta <sensor>` (que sólo
 * cede, sin dormir) giraría con el reloj virtual congelado y el sensor nunca
 * cambiaría. Además reproduce una propiedad REAL de la placa: un
 * `por siempre` con esperas deriva un poco en cada vuelta, porque el siguiente
 * `wait` se cuenta desde que el hilo despierta, no desde que debió despertar.
 */
const ROUND_MS = 5;

/** Tope de rondas del planificador, para que un bug no cuelgue los tests. */
const MAX_ROUNDS = 1000000;

class ReferenceVM {
    /**
     * @param {Uint8Array} binary Programa serializado.
     * @param {object} [options] Opciones.
     * @param {object} [options.hwMap] Mapa de hardware de la placa (para
     *     validar aridad y resolver nombres en el registro).
     * @param {object} [options.hardware] Sink de hardware: `call(name, args)`
     *     ejecuta una primitiva y devuelve, para las de tipo 'reporter', el
     *     valor leído; para las de tipo 'wait', los milisegundos que tardará.
     */
    constructor (binary, options) {
        const opts = options || {};

        const program = parseProgram(binary);
        this.program = program;
        this.code = program.code;
        this.strings = program.strings;

        this._hwMap = opts.hwMap || null;
        this._hardware = opts.hardware || null;

        /** Reloj virtual en milisegundos. */
        this.now = 0;
        /** Instante del último `TIMER_RESET` (bloque "cronómetro"). */
        this._timerBase = 0;

        this.vars = new Array(program.numVars).fill(null)
            .map(() => V.num(0));

        /** Registro de llamadas a hardware: `{t, hw, args}`. */
        this.log = [];

        this.error = RUNTIME_ERRORS.NONE;
        this.errorDetail = null;

        this.threads = program.threads.map(t => ({
            pc: t.entryPc,
            hatKind: t.hatKind,
            status: STATUS.RUNNING,
            stack: [],
            loopStack: [],
            wakeAt: 0,
            hwWaitUntil: 0
        }));
    }

    // -- Lectura de operandos ------------------------------------------------

    /**
     * @param {object} t Hilo.
     * @returns {number} Byte sin signo en el PC, avanzando el PC.
     */
    _u8 (t) {
        return this.code[t.pc++];
    }

    /**
     * @param {object} t Hilo.
     * @returns {number} Byte con signo.
     */
    _i8 (t) {
        const v = this.code[t.pc++];
        return v > 127 ? v - 256 : v;
    }

    /**
     * @param {object} t Hilo.
     * @returns {number} Entero de 16 bits sin signo.
     */
    _u16 (t) {
        const v = this.code[t.pc] | (this.code[t.pc + 1] << 8);
        t.pc += 2;
        return v;
    }

    /**
     * @param {object} t Hilo.
     * @returns {number} Entero de 16 bits con signo.
     */
    _i16 (t) {
        const v = this._u16(t);
        return v > 32767 ? v - 65536 : v;
    }

    /**
     * @param {object} t Hilo.
     * @returns {number} Float de 32 bits.
     */
    _f32 (t) {
        const buf = new ArrayBuffer(4);
        const view = new Uint8Array(buf);
        view[0] = this.code[t.pc];
        view[1] = this.code[t.pc + 1];
        view[2] = this.code[t.pc + 2];
        view[3] = this.code[t.pc + 3];
        t.pc += 4;
        return new DataView(buf).getFloat32(0, true);
    }

    // -- Errores -------------------------------------------------------------

    /**
     * Aborta el programa con un código de error.
     * @param {number} code Código de RUNTIME_ERRORS.
     * @param {string} detail Explicación para depurar.
     */
    _fail (code, detail) {
        this.error = code;
        this.errorDetail = detail;
        for (const t of this.threads) t.status = STATUS.DONE;
    }

    // -- Hardware ------------------------------------------------------------

    /**
     * Invoca una primitiva de hardware, validando su aridad igual que hará el
     * firmware.
     * @param {number} hwId Id de la primitiva.
     * @param {number} argc Aridad declarada en la instrucción.
     * @param {Array.<object>} args Argumentos ya desapilados.
     * @returns {*} Lo que devuelva el sink de hardware.
     */
    _callHardware (hwId, argc, args) {
        const name = this._hwMap ? this._hwMap.HW_NAMES[hwId] : null;
        if (this._hwMap && !name) {
            this._fail(RUNTIME_ERRORS.BAD_HW_ID, `hwId desconocido: 0x${hwId.toString(16)}`);
            return null;
        }
        if (name) {
            const spec = this._hwMap.HW[name];
            // Misma verificación que el firmware: caza la desincronización de
            // tablas como error limpio, no como pila corrupta.
            if (spec.argc !== argc) {
                this._fail(
                    RUNTIME_ERRORS.ARITY,
                    `${name} espera ${spec.argc} argumento(s) y la instrucción declara ${argc}`
                );
                return null;
            }
        }

        const plain = args.map(a => (a.type === V.VAL.STR ? V.toString(a) : V.toNumber(a)));
        this.log.push({t: this.now, hw: name || hwId, args: plain});

        if (this._hardware && typeof this._hardware.call === 'function') {
            return this._hardware.call(name || hwId, plain);
        }
        return 0;
    }

    // -- Ejecución -----------------------------------------------------------

    /**
     * Ejecuta un hilo hasta que ceda, termine o agote su presupuesto.
     * @param {object} t Hilo.
     */
    _runThread (t) {
        let budget = INSTR_BUDGET;

        while (t.status === STATUS.RUNNING && budget-- > 0) {
            if (t.pc < 0 || t.pc >= this.code.length) {
                this._fail(RUNTIME_ERRORS.BAD_OPCODE, `PC fuera de rango: ${t.pc}`);
                return;
            }

            const op = this._u8(t);
            const push = v => t.stack.push(v);
            const pop = () => {
                if (t.stack.length === 0) {
                    this._fail(RUNTIME_ERRORS.STACK_OVERFLOW, 'pop con la pila vacía');
                    return V.num(0);
                }
                return t.stack.pop();
            };

            switch (op) {
            case OPCODES.NOP:
                break;

            // -- Constantes y pila --
            case OPCODES.PUSH_F32: push(V.num(this._f32(t))); break;
            case OPCODES.PUSH_I8: push(V.num(this._i8(t))); break;
            case OPCODES.PUSH_STR: push(V.str(this.strings[this._u16(t)])); break;
            case OPCODES.PUSH_TRUE: push(V.bool(true)); break;
            case OPCODES.PUSH_FALSE: push(V.bool(false)); break;
            case OPCODES.POP: pop(); break;
            case OPCODES.DUP: {
                const v = pop();
                push(v);
                push(v);
                break;
            }

            // -- Variables --
            case OPCODES.LOAD_VAR: push(this.vars[this._u8(t)] || V.num(0)); break;
            case OPCODES.STORE_VAR: {
                const slot = this._u8(t);
                this.vars[slot] = pop();
                break;
            }
            case OPCODES.CHANGE_VAR: {
                const slot = this._u8(t);
                const delta = V.toNumber(pop());
                this.vars[slot] = V.num(V.toNumber(this.vars[slot] || V.num(0)) + delta);
                break;
            }

            // -- Aritmética --
            case OPCODES.ADD: {
                const b = V.toNumber(pop());
                push(V.num(V.toNumber(pop()) + b));
                break;
            }
            case OPCODES.SUB: {
                const b = V.toNumber(pop());
                push(V.num(V.toNumber(pop()) - b));
                break;
            }
            case OPCODES.MUL: {
                const b = V.toNumber(pop());
                push(V.num(V.toNumber(pop()) * b));
                break;
            }
            case OPCODES.DIV: {
                const b = V.toNumber(pop());
                const a = V.toNumber(pop());
                // Scratch devuelve Infinity al dividir por cero; se conserva
                // para no divergir del modo directo.
                push(V.num(a / b));
                break;
            }
            case OPCODES.MOD: {
                const b = V.toNumber(pop());
                const a = V.toNumber(pop());
                let r = a % b;
                // Scratch usa módulo con el signo del divisor.
                if (r / b < 0) r += b;
                push(V.num(r));
                break;
            }
            case OPCODES.RANDOM: {
                const hi = V.toNumber(pop());
                const lo = V.toNumber(pop());
                const low = Math.min(lo, hi);
                const high = Math.max(lo, hi);
                // Entero si ambos extremos lo son (igual que Scratch).
                if (Number.isInteger(low) && Number.isInteger(high)) {
                    push(V.num(low + Math.floor(this._random() * ((high - low) + 1))));
                } else {
                    push(V.num(low + (this._random() * (high - low))));
                }
                break;
            }
            case OPCODES.ROUND: push(V.num(Math.round(V.toNumber(pop())))); break;
            case OPCODES.MATHOP: {
                const fn = MATHOP_FUNCTIONS[this._u8(t)];
                const x = V.toNumber(pop());
                push(V.num(this._mathop(fn, x)));
                break;
            }

            // -- Comparación y lógica --
            case OPCODES.LT: {
                const b = pop();
                push(V.bool(V.compare(pop(), b) < 0));
                break;
            }
            case OPCODES.EQ: {
                const b = pop();
                push(V.bool(V.compare(pop(), b) === 0));
                break;
            }
            case OPCODES.GT: {
                const b = pop();
                push(V.bool(V.compare(pop(), b) > 0));
                break;
            }
            case OPCODES.AND: {
                const b = V.toBoolean(pop());
                push(V.bool(V.toBoolean(pop()) && b));
                break;
            }
            case OPCODES.OR: {
                const b = V.toBoolean(pop());
                push(V.bool(V.toBoolean(pop()) || b));
                break;
            }
            case OPCODES.NOT: push(V.bool(!V.toBoolean(pop()))); break;

            // -- Strings --
            case OPCODES.JOIN: {
                const b = V.toString(pop());
                push(V.str(V.toString(pop()) + b));
                break;
            }
            case OPCODES.LETTER_OF: {
                const s = V.toString(pop());
                const i = V.toNumber(pop());
                push(V.str(i >= 1 && i <= s.length ? s.charAt(i - 1) : ''));
                break;
            }
            case OPCODES.LENGTH: push(V.num(V.toString(pop()).length)); break;
            case OPCODES.CONTAINS: {
                const needle = V.toString(pop()).toLowerCase();
                push(V.bool(V.toString(pop()).toLowerCase()
                    .includes(needle)));
                break;
            }

            // -- Saltos --
            case OPCODES.JMP: {
                // El offset se lee ANTES de sumarlo: `t.pc += this._i16(t)`
                // usaría el pc previo a que _i16() lo avance.
                const offset = this._i16(t);
                t.pc += offset;
                break;
            }
            case OPCODES.JZ: {
                const offset = this._i16(t);
                if (!V.toBoolean(pop())) t.pc += offset;
                break;
            }
            case OPCODES.JNZ: {
                const offset = this._i16(t);
                if (V.toBoolean(pop())) t.pc += offset;
                break;
            }
            case OPCODES.REPEAT_SETUP: {
                const n = Math.round(V.toNumber(pop()));
                t.loopStack.push(Math.max(0, n));
                break;
            }
            case OPCODES.LOOP_TEST: {
                const offset = this._i16(t);
                if (t.loopStack[t.loopStack.length - 1] <= 0) {
                    t.loopStack.pop();
                    t.pc += offset;
                }
                break;
            }
            case OPCODES.LOOP_NEXT: {
                const offset = this._i16(t);
                t.loopStack[t.loopStack.length - 1]--;
                t.pc += offset;
                break;
            }

            // -- Tiempo y planificación --
            case OPCODES.YIELD:
                t.status = STATUS.YIELD_TICK;
                return;
            case OPCODES.WAIT: {
                const seconds = V.toNumber(pop());
                t.wakeAt = this.now + Math.max(0, seconds * 1000);
                t.status = STATUS.WAIT_TIMER;
                return;
            }
            case OPCODES.TIMER: push(V.num((this.now - this._timerBase) / 1000)); break;
            case OPCODES.TIMER_RESET: this._timerBase = this.now; break;
            case OPCODES.STOP: {
                const mode = this._u8(t);
                if (mode === STOP_MODES.all) {
                    for (const other of this.threads) other.status = STATUS.DONE;
                    this._safeStop();
                } else if (mode === STOP_MODES['this script']) {
                    t.status = STATUS.DONE;
                } else {
                    for (const other of this.threads) {
                        if (other !== t) other.status = STATUS.DONE;
                    }
                }
                return;
            }
            case OPCODES.HALT:
                t.status = STATUS.DONE;
                return;

            // -- Hardware --
            case OPCODES.CALL_HW: {
                const hwId = this._u8(t);
                const argc = this._u8(t);
                const args = t.stack.splice(t.stack.length - argc, argc);
                this._callHardware(hwId, argc, args);
                break;
            }
            case OPCODES.CALL_HW_R: {
                const hwId = this._u8(t);
                const argc = this._u8(t);
                const args = t.stack.splice(t.stack.length - argc, argc);
                const result = this._callHardware(hwId, argc, args);
                push(typeof result === 'string' ? V.str(result) :
                    (typeof result === 'boolean' ? V.bool(result) : V.num(result || 0)));
                break;
            }
            case OPCODES.CALL_HW_WAIT: {
                const hwId = this._u8(t);
                const argc = this._u8(t);
                const args = t.stack.splice(t.stack.length - argc, argc);
                const durationMs = this._callHardware(hwId, argc, args);
                t.hwWaitUntil = this.now + Math.max(0, Number(durationMs) || 0);
                t.status = STATUS.WAIT_HW;
                return;
            }

            case OPCODES.TRAP:
                this._fail(this._u8(t), 'TRAP');
                return;

            default:
                this._fail(
                    RUNTIME_ERRORS.BAD_OPCODE,
                    `opcode desconocido 0x${op.toString(16)} en pc=${t.pc - 1}`
                );
                return;
            }

            if (this.error !== RUNTIME_ERRORS.NONE) return;
        }

        // Presupuesto agotado sin ceder: se trata como cesión, igual que el
        // WORK_TIME del sequencer de Scratch.
        if (t.status === STATUS.RUNNING) t.status = STATUS.YIELD_TICK;
    }

    /**
     * @param {string} fn Nombre de la función.
     * @param {number} x Argumento.
     * @returns {number} Resultado, con la semántica de `operator_mathop`.
     */
    _mathop (fn, x) {
        switch (fn) {
        case 'abs': return Math.abs(x);
        case 'floor': return Math.floor(x);
        case 'ceiling': return Math.ceil(x);
        case 'sqrt': return Math.sqrt(x);
        case 'sin': return parseFloat(Math.sin((Math.PI * x) / 180).toFixed(10));
        case 'cos': return parseFloat(Math.cos((Math.PI * x) / 180).toFixed(10));
        case 'tan': return parseFloat(Math.tan((Math.PI * x) / 180).toFixed(10));
        case 'asin': return (Math.asin(x) * 180) / Math.PI;
        case 'acos': return (Math.acos(x) * 180) / Math.PI;
        case 'atan': return (Math.atan(x) * 180) / Math.PI;
        case 'ln': return Math.log(x);
        case 'log': return Math.log(x) / Math.LN10;
        case 'e ^': return Math.exp(x);
        case '10 ^': return Math.pow(10, x);
        default: return 0;
        }
    }

    /**
     * Aleatorio. Se aísla en un método para poder fijarlo en los tests.
     * @returns {number} Número en [0, 1).
     */
    _random () {
        return Math.random();
    }

    /** Apagado seguro del hardware al detener el programa. */
    _safeStop () {
        this.log.push({t: this.now, hw: 'safeStop', args: []});
    }

    // -- Planificador --------------------------------------------------------

    /**
     * Despierta los hilos cuya espera ya venció.
     */
    _wakeThreads () {
        for (const t of this.threads) {
            if (t.status === STATUS.WAIT_TIMER && this.now >= t.wakeAt) {
                t.status = STATUS.RUNNING;
            } else if (t.status === STATUS.WAIT_HW && this.now >= t.hwWaitUntil) {
                t.status = STATUS.RUNNING;
            } else if (t.status === STATUS.YIELD_TICK) {
                t.status = STATUS.RUNNING;
            }
        }
    }

    /**
     * @returns {number|null} El instante más próximo en que algún hilo
     *     dormido despertará, o null si no hay ninguno esperando.
     */
    _nextWakeTime () {
        let earliest = null;
        for (const t of this.threads) {
            let at = null;
            if (t.status === STATUS.WAIT_TIMER) at = t.wakeAt;
            else if (t.status === STATUS.WAIT_HW) at = t.hwWaitUntil;
            if (at !== null && (earliest === null || at < earliest)) earliest = at;
        }
        return earliest;
    }

    /** @returns {boolean} True si queda algún hilo vivo. */
    isRunning () {
        return this.threads.some(t => t.status !== STATUS.DONE) &&
            this.error === RUNTIME_ERRORS.NONE;
    }

    /**
     * Corre el programa hasta que termine o hasta `untilMs` de tiempo virtual.
     *
     * Cuando todos los hilos están dormidos, el reloj SALTA al despertar más
     * próximo en vez de avanzar de a poquitos: por eso simular diez minutos de
     * robot cuesta milisegundos.
     *
     * @param {number} untilMs Tope de tiempo virtual (ms).
     * @returns {Array.<object>} El registro de llamadas de hardware.
     */
    run (untilMs) {
        const limit = typeof untilMs === 'number' ? untilMs : Infinity;
        let rounds = 0;

        while (this.isRunning() && this.now < limit) {
            if (rounds++ > MAX_ROUNDS) {
                this._fail(RUNTIME_ERRORS.RUNAWAY, 'demasiadas rondas del planificador');
                break;
            }

            this._wakeThreads();

            const runnable = this.threads.filter(t => t.status === STATUS.RUNNING);
            if (runnable.length > 0) {
                for (const t of runnable) {
                    if (t.status === STATUS.RUNNING) this._runThread(t);
                }
                // Una pasada del loop() del firmware consume tiempo real.
                this.now += ROUND_MS;
                continue;
            }

            // Nadie puede correr: o todos duermen (saltamos el reloj) o
            // terminamos.
            const next = this._nextWakeTime();
            if (next === null) break;
            if (next > limit) {
                this.now = limit;
                break;
            }
            this.now = next;
        }

        return this.log;
    }

    /**
     * Desensambla el código, para diagnosticar tests que fallan.
     * @returns {Array.<string>} Una línea por instrucción.
     */
    disassemble () {
        const lines = [];
        const t = {pc: 0};
        while (t.pc < this.code.length) {
            const at = t.pc;
            const op = this._u8(t);
            const name = OPCODE_NAMES[op] || `??0x${op.toString(16)}`;
            const parts = [];

            switch (op) {
            case OPCODES.PUSH_F32: parts.push(String(this._f32(t))); break;
            case OPCODES.PUSH_I8: parts.push(String(this._i8(t))); break;
            case OPCODES.PUSH_STR: parts.push(`"${this.strings[this._u16(t)]}"`); break;
            case OPCODES.LOAD_VAR:
            case OPCODES.STORE_VAR:
            case OPCODES.CHANGE_VAR:
            case OPCODES.MATHOP:
            case OPCODES.STOP:
            case OPCODES.TRAP:
                parts.push(`#${this._u8(t)}`);
                break;
            case OPCODES.JMP:
            case OPCODES.JZ:
            case OPCODES.JNZ:
            case OPCODES.LOOP_TEST:
            case OPCODES.LOOP_NEXT: {
                const offset = this._i16(t);
                parts.push(`${offset >= 0 ? '+' : ''}${offset} -> ${t.pc + offset}`);
                break;
            }
            case OPCODES.CALL_HW:
            case OPCODES.CALL_HW_R:
            case OPCODES.CALL_HW_WAIT: {
                const hwId = this._u8(t);
                const argc = this._u8(t);
                const hwName = this._hwMap ? this._hwMap.HW_NAMES[hwId] : null;
                parts.push(`${hwName || `0x${hwId.toString(16)}`}/${argc}`);
                break;
            }
            default:
                break;
            }

            lines.push(`${String(at).padStart(4, '0')}  ${name}${parts.length ? ` ${parts.join(' ')}` : ''}`);
        }
        return lines;
    }
}

module.exports = ReferenceVM;
module.exports.STATUS = STATUS;
