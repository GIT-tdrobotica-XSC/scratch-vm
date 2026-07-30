/**
 * Tests del compilador de bloques (F1).
 *
 * Se construyen bloques REALES con `Blocks.createBlock()` (igual que
 * `engine_blocks.js`), se compilan, y se ejecuta el bytecode resultante en el
 * intérprete de referencia. Así cada test comprueba la cadena entera
 * —bloques → bytecode → binario → ejecución— y no sólo una pieza.
 */

const test = require('tap').test;

const Blocks = require('../../src/engine/blocks');
const Runtime = require('../../src/engine/runtime');
const {compileBlocks} = require('../../src/compiler');
const ReferenceVM = require('../../src/compiler/reference-vm/vm');
const playgo = require('../../src/compiler/targets/playgo/hw-map');
const {ErrorCode} = require('../../src/compiler/errors');

let nextId = 0;
/**
 * @param {string} prefix Prefijo legible.
 * @returns {string} Id único de bloque.
 */
const uid = prefix => `${prefix}${nextId++}`;

/**
 * Constructor de bloques con una API compacta, para que los tests se lean.
 */
class Script {
    constructor () {
        this.blocks = new Blocks(new Runtime());
    }

    /**
     * Crea un bloque y lo registra.
     * @param {string} opcode Opcode.
     * @param {object} [opts] `{fields, inputs, topLevel, shadow, next}`.
     * @returns {string} Id del bloque creado.
     */
    add (opcode, opts) {
        const o = opts || {};
        const id = o.id || uid(opcode.replace(/[^a-z]/gi, ''));
        const fields = {};
        for (const name of Object.keys(o.fields || {})) {
            fields[name] = {name, value: o.fields[name], id: o.fieldIds && o.fieldIds[name]};
        }
        const inputs = {};
        for (const name of Object.keys(o.inputs || {})) {
            const v = o.inputs[name];
            inputs[name] = {name, block: v.block || v, shadow: v.shadow || null};
        }
        this.blocks.createBlock({
            id,
            opcode,
            inputs,
            fields,
            next: o.next || null,
            topLevel: !!o.topLevel,
            shadow: !!o.shadow,
            parent: null
        });
        return id;
    }

    /**
     * Crea un literal numérico (bloque sombra).
     * @param {number|string} value Valor.
     * @returns {string} Id.
     */
    num (value) {
        return this.add('math_number', {fields: {NUM: value}, shadow: true});
    }

    /**
     * Crea un literal de texto.
     * @param {string} value Valor.
     * @returns {string} Id.
     */
    text (value) {
        return this.add('text', {fields: {TEXT: value}, shadow: true});
    }

    /**
     * Encadena una lista de ids como secuencia de sentencias.
     * @param {Array.<string>} ids Ids en orden.
     */
    chain (ids) {
        for (let i = 0; i < ids.length - 1; i++) {
            this.blocks.getBlock(ids[i]).next = ids[i + 1];
            this.blocks.getBlock(ids[i + 1]).parent = ids[i];
        }
    }

    /**
     * Crea el sombrero de bandera verde encima de una cadena.
     * @param {string} firstId Primer bloque del cuerpo.
     * @returns {string} Id del sombrero.
     */
    flag (firstId) {
        const hat = this.add('event_whenflagclicked', {topLevel: true});
        if (firstId) {
            this.blocks.getBlock(hat).next = firstId;
            this.blocks.getBlock(firstId).parent = hat;
        }
        return hat;
    }
}

/**
 * Compila y devuelve el resultado.
 * @param {Script} script Script.
 * @returns {object} Resultado de compileBlocks.
 */
const compile = script => compileBlocks(script.blocks, 'playgo');

/**
 * Compila y ejecuta, devolviendo el registro de hardware.
 * @param {Script} script Script.
 * @param {number} [ms] Tiempo virtual a simular.
 * @param {object} [hardware] Sink de hardware.
 * @returns {Array.<object>} Registro de llamadas.
 */
const run = function (script, ms, hardware) {
    const {bytes} = compile(script);
    const vm = new ReferenceVM(bytes, {hwMap: playgo, hardware});
    if (hardware) hardware.vm = vm;
    vm.run(typeof ms === 'number' ? ms : 5000);
    return vm.log;
};

/**
 * Captura los errores de una compilación que debe fallar.
 * @param {Script} script Script.
 * @returns {Array.<object>} Errores.
 */
const errorsOf = function (script) {
    try {
        compile(script);
    } catch (group) {
        return group.errors || [group];
    }
    return [];
};

// ── Bloques de dispositivo ───────────────────────────────────────────────

test('motores: los argumentos se acotan a -100..100 como en modo directo', t => {
    const s = new Script();
    const motors = s.add('playgo_setMotorSpeeds', {
        inputs: {LEFT: s.num(500), RIGHT: s.num(-500)}
    });
    s.flag(motors);

    const log = run(s, 100);
    t.equal(log.length, 1);
    t.equal(log[0].hw, 'setMotorSpeed');
    t.same(log[0].args, [100, -100], 'se acota igual que el handler de JS');
    t.end();
});

test('los presets de color se pliegan en tiempo de compilación', t => {
    const s = new Script();
    const led = s.add('playgo_menu_rgbLeds', {fields: {rgbLeds: '3'}, shadow: true});
    const rgb = s.add('playgo_setRGBPreset', {
        fields: {PRESET: 'cyan'},
        inputs: {LED: led}
    });
    s.flag(rgb);

    const log = run(s, 100);
    t.equal(log[0].hw, 'setRGB', 'los cinco bloques RGB usan la misma primitiva');
    t.same(log[0].args, [3, 0, 255, 255], 'cian quedó plegado a 0,255,255');
    t.end();
});

test('"apagar todos los LEDs" usa led = -1', t => {
    const s = new Script();
    s.flag(s.add('playgo_allRGBOff'));
    const log = run(s, 100);
    t.same(log[0].args, [playgo.RGB_ALL, 0, 0, 0]);
    t.end();
});

test('el color hexadecimal se descompone al compilar', t => {
    const s = new Script();
    s.flag(s.add('playgo_setAllRGB', {fields: {COLOR: '#ff8000'}}));
    const log = run(s, 100);
    t.same(log[0].args, [-1, 255, 128, 0]);
    t.end();
});

test('las notas musicales se convierten a frecuencia al compilar', t => {
    const s = new Script();
    const note = s.add('playgo_playNote', {
        fields: {NOTE: 'A', OCTAVE: '4'},
        inputs: {DURATION: s.num(500)}
    });
    s.flag(note);

    const log = run(s, 3000);
    t.equal(log[0].hw, 'tone');
    t.equal(log[0].args[0], 440, 'La4 = 440 Hz, plegado sin tocar el firmware');
    t.equal(log[0].args[1], 500);
    t.end();
});

test('un tono con duración espera esa duración antes de seguir', t => {
    const s = new Script();
    const tone = s.add('playgo_playTone', {
        inputs: {FREQ: s.num(880), DURATION: s.num(250)}
    });
    const stop = s.add('playgo_stopMotors');
    s.chain([tone, stop]);
    s.flag(tone);

    const log = run(s, 3000);
    t.equal(log[0].t, 0, 'el tono suena de inmediato');
    t.equal(log[1].hw, 'stopMotors');
    t.equal(log[1].t, 250, 'lo siguiente ocurre 250 ms después');
    t.end();
});

test('la duración del tono se evalúa UNA sola vez aunque sea una expresión', t => {
    // Si el compilador compilara DURATION dos veces (una para la llamada y
    // otra para la espera), un reporter con efectos se leería dos veces.
    const s = new Script();
    const reader = s.add('playgo_analogReadPB', {fields: {PIN: '1'}});
    const tone = s.add('playgo_playTone', {
        inputs: {FREQ: s.num(440), DURATION: reader}
    });
    s.flag(tone);

    const hardware = {vm: null, call: () => 2048};
    const log = run(s, 5000, hardware);

    const reads = log.filter(l => l.hw === 'readAnalog');
    t.equal(reads.length, 1, 'el sensor se leyó una sola vez');
    t.end();
});

test('la lectura analógica se mapea 0-4095 -> 0-100 con aritmética de bytecode', t => {
    const s = new Script();
    const reader = s.add('playgo_analogReadPB', {fields: {PIN: '2'}});
    const oled = s.add('playgo_oledNumber', {
        fields: {LINE: '0'},
        inputs: {LABEL: s.text('Pot'), VALUE: reader}
    });
    s.flag(oled);

    const hardware = {vm: null, call: () => 4095};
    const log = run(s, 100, hardware);

    const read = log.find(l => l.hw === 'readAnalog');
    t.same(read.args, [2], 'lee la entrada 2');
    const show = log.find(l => l.hw === 'oledNumber');
    t.same(show.args, [0, 'Pot', 100], '4095 se mostró como 100, sin primitiva nueva');
    t.end();
});

test('los puertos de servo A-D se traducen a GPIO 11-14', t => {
    const s = new Script();
    s.flag(s.add('playgo_setServoPlayGo', {
        fields: {PORT: 'C'},
        inputs: {ANGLE: s.num(45)}
    }));
    const log = run(s, 100);
    t.same(log[0].args, [13, 45], 'el puerto C es el GPIO 13');
    t.end();
});

test('un texto de la pantalla viaja en la tabla de strings', t => {
    const s = new Script();
    s.flag(s.add('playgo_oledText', {
        fields: {SIZE: '2'},
        inputs: {TEXT: s.text('Hola mundo')}
    }));

    const {bytes, stats} = compile(s);
    t.equal(stats.strings, 1, 'un solo texto en la tabla');

    const vm = new ReferenceVM(bytes, {hwMap: playgo});
    vm.run(100);
    t.same(vm.log[0].args, ['Hola mundo', 2]);
    t.end();
});

// ── Control de flujo ─────────────────────────────────────────────────────

test('repetir N veces ejecuta exactamente N veces', t => {
    const s = new Script();
    const body = s.add('playgo_stopMotors');
    const repeat = s.add('playgo_stopMotors'); // placeholder, se reemplaza
    s.blocks.deleteBlock(repeat);

    const loop = s.add('control_repeat', {
        inputs: {TIMES: s.num(4), SUBSTACK: body}
    });
    s.flag(loop);

    const log = run(s, 5000);
    t.equal(log.filter(l => l.hw === 'stopMotors').length, 4);
    t.end();
});

test('si / si-no eligen la rama correcta', t => {
    const build = function (condition) {
        const s = new Script();
        const yes = s.add('playgo_oledClear');
        const no = s.add('playgo_oledDisplay');
        const cond = condition ? s.add('operator_gt', {
            inputs: {OPERAND1: s.num(5), OPERAND2: s.num(3)}
        }) : s.add('operator_gt', {
            inputs: {OPERAND1: s.num(1), OPERAND2: s.num(3)}
        });
        const branch = s.add('control_if_else', {
            inputs: {CONDITION: cond, SUBSTACK: yes, SUBSTACK2: no}
        });
        s.flag(branch);
        return run(s, 500).map(l => l.hw);
    };

    t.same(build(true), ['oledClear'], 'condición verdadera -> primera rama');
    t.same(build(false), ['oledDisplay'], 'condición falsa -> segunda rama');
    t.end();
});

test('una condición vacía cuenta como falsa (igual que Scratch)', t => {
    const s = new Script();
    const body = s.add('playgo_oledClear');
    s.flag(s.add('control_if', {inputs: {SUBSTACK: body}}));
    t.equal(run(s, 500).length, 0, 'no entró en el si');
    t.end();
});

test('repetir hasta que sale cuando la condición se cumple', t => {
    const s = new Script();
    const counter = {name: 'i', id: 'var-i'};

    const inc = s.add('data_changevariableby', {
        fields: {VARIABLE: counter.name},
        fieldIds: {VARIABLE: counter.id},
        inputs: {VALUE: s.num(1)}
    });
    const beep = s.add('playgo_oledDisplay');
    s.chain([inc, beep]);

    const read = s.add('data_variable', {
        fields: {VARIABLE: counter.name},
        fieldIds: {VARIABLE: counter.id}
    });
    const cond = s.add('operator_gt', {inputs: {OPERAND1: read, OPERAND2: s.num(2)}});
    const loop = s.add('control_repeat_until', {
        inputs: {CONDITION: cond, SUBSTACK: inc}
    });
    s.flag(loop);

    const log = run(s, 5000);
    t.equal(log.filter(l => l.hw === 'oledDisplay').length, 3,
        'itera hasta que el contador pasa de 2');
    t.end();
});

test('por siempre repite indefinidamente y avisa de los bloques que le siguen', t => {
    const s = new Script();
    const body = s.add('playgo_oledDisplay');
    const forever = s.add('control_forever', {inputs: {SUBSTACK: body}});
    const after = s.add('playgo_stopMotors');
    s.chain([forever, after]);
    s.flag(forever);

    const {warnings} = compile(s);
    t.ok(warnings.some(w => w.code === 'UNREACHABLE'),
        'avisa que lo de después del "por siempre" nunca corre');

    const log = run(s, 500);
    t.ok(log.length > 10, 'el bucle sigue girando');
    t.notOk(log.some(l => l.hw === 'stopMotors'), 'lo inalcanzable no se compiló');
    t.end();
});

test('esperar duerme el tiempo pedido', t => {
    const s = new Script();
    const a = s.add('playgo_oledClear');
    const wait = s.add('control_wait', {inputs: {DURATION: s.num(2)}});
    const b = s.add('playgo_oledDisplay');
    s.chain([a, wait, b]);
    s.flag(a);

    const log = run(s, 10000);
    t.equal(log[0].t, 0);
    t.equal(log[1].t, 2000, 'esperó exactamente 2 segundos');
    t.end();
});

test('detener todos apaga el hardware', t => {
    const s = new Script();
    const stop = s.add('control_stop', {fields: {STOP_OPTION: 'all'}});
    s.flag(stop);
    const log = run(s, 500);
    t.ok(log.some(l => l.hw === 'safeStop'));
    t.end();
});

// ── Operadores y variables ───────────────────────────────────────────────

test('la aritmética se evalúa en la placa', t => {
    const s = new Script();
    const sum = s.add('operator_add', {inputs: {NUM1: s.num(20), NUM2: s.num(30)}});
    const motors = s.add('playgo_setMotorSpeeds', {
        inputs: {LEFT: sum, RIGHT: s.num(0)}
    });
    s.flag(motors);

    const log = run(s, 100);
    t.equal(log[0].args[0], 50, '20 + 30 se calculó en el bytecode');
    t.end();
});

test('las variables se guardan y se leen', t => {
    const s = new Script();
    const set = s.add('data_setvariableto', {
        fields: {VARIABLE: 'v'},
        fieldIds: {VARIABLE: 'var-v'},
        inputs: {VALUE: s.num(75)}
    });
    const read = s.add('data_variable', {
        fields: {VARIABLE: 'v'},
        fieldIds: {VARIABLE: 'var-v'}
    });
    const motors = s.add('playgo_setMotorSpeeds', {
        inputs: {LEFT: read, RIGHT: s.num(0)}
    });
    s.chain([set, motors]);
    s.flag(set);

    const log = run(s, 100);
    t.equal(log[0].args[0], 75);
    t.end();
});

test('varias banderas verdes producen varios hilos', t => {
    const s = new Script();
    const a = s.add('playgo_oledClear');
    s.flag(a);
    const b = s.add('playgo_oledDisplay');
    s.flag(b);

    const {stats} = compile(s);
    t.equal(stats.threads, 2, 'dos hilos');

    const log = run(s, 200);
    t.ok(log.some(l => l.hw === 'oledClear'));
    t.ok(log.some(l => l.hw === 'oledDisplay'));
    t.end();
});

// ── Errores ──────────────────────────────────────────────────────────────

test('un bloque que necesita el computador da un error accionable', t => {
    const s = new Script();
    const key = s.add('sensing_keypressed', {inputs: {KEY_OPTION: s.text('space')}});
    const body = s.add('playgo_stopMotors');
    const branch = s.add('control_if', {inputs: {CONDITION: key, SUBSTACK: body}});
    s.flag(branch);

    const errs = errorsOf(s);
    t.equal(errs.length, 1);
    t.equal(errs[0].code, ErrorCode.NEEDS_COMPUTER);
    t.match(errs[0].message, /necesita el computador/);
    t.ok(errs[0].hint, 'sugiere qué usar en su lugar');
    t.equal(errs[0].blockId, key, 'señala el bloque exacto para poder resaltarlo');
    t.end();
});

test('se reportan TODOS los errores, no sólo el primero', t => {
    const s = new Script();
    const k1 = s.add('sensing_keypressed', {inputs: {KEY_OPTION: s.text('a')}});
    const if1 = s.add('control_if', {
        inputs: {CONDITION: k1, SUBSTACK: s.add('playgo_oledClear')}
    });
    const k2 = s.add('sensing_mousedown');
    const if2 = s.add('control_if', {
        inputs: {CONDITION: k2, SUBSTACK: s.add('playgo_oledDisplay')}
    });
    const say = s.add('looks_say', {inputs: {MESSAGE: s.text('hola')}});
    s.chain([if1, if2, say]);
    s.flag(if1);

    const errs = errorsOf(s);
    t.equal(errs.length, 3, 'los tres bloques problemáticos salen de una vez');
    const ids = errs.map(e => e.blockId);
    t.ok(ids.includes(k1) && ids.includes(k2) && ids.includes(say));
    t.end();
});

test('un proyecto sin bandera verde explica qué falta', t => {
    const s = new Script();
    s.add('playgo_stopMotors', {topLevel: true});

    const errs = errorsOf(s);
    t.equal(errs.length, 1);
    t.equal(errs[0].code, ErrorCode.NO_HAT);
    t.end();
});

test('los "Mis bloques" dan un mensaje propio, no uno genérico', t => {
    const s = new Script();
    const call = s.add('procedures_call');
    s.flag(call);

    const errs = errorsOf(s);
    t.equal(errs[0].code, ErrorCode.PROCEDURE_UNSUPPORTED);
    t.match(errs[0].message, /Mis bloques/);
    t.end();
});

test('demasiadas banderas verdes se detecta antes de subir', t => {
    const s = new Script();
    for (let i = 0; i < 9; i++) s.flag(s.add('playgo_oledClear'));

    const errs = errorsOf(s);
    t.ok(errs.some(e => e.code === ErrorCode.TOO_MANY_THREADS));
    t.end();
});

test('las expresiones demasiado anidadas se cazan estáticamente', t => {
    const s = new Script();
    // 20 sumas anidadas por la DERECHA. Sólo ese lado hace crecer la pila:
    // anidando por la izquierda, cada nivel resuelve su operando izquierdo
    // entero antes de empujar el derecho, así que la profundidad se queda en 2.
    let expr = s.num(1);
    for (let i = 0; i < 20; i++) {
        expr = s.add('operator_add', {inputs: {NUM1: s.num(1), NUM2: expr}});
    }
    const motors = s.add('playgo_setMotorSpeeds', {
        inputs: {LEFT: expr, RIGHT: s.num(0)}
    });
    s.flag(motors);

    const errs = errorsOf(s);
    t.ok(errs.some(e => e.code === ErrorCode.STACK_TOO_DEEP),
        'sale como mensaje en pantalla, no como robot congelado en el aula');
    t.end();
});

test('los bloques sueltos avisan pero no bloquean la subida', t => {
    const s = new Script();
    s.flag(s.add('playgo_oledClear'));
    s.add('playgo_stopMotors', {topLevel: true}); // suelto, sin sombrero

    const {warnings, stats} = compile(s);
    t.equal(stats.threads, 1, 'sólo se compiló el script con bandera');
    t.ok(warnings.some(w => w.code === 'ORPHAN_SCRIPT'));
    t.end();
});

test('"mostrar variable" avisa pero no rompe nada', t => {
    const s = new Script();
    const show = s.add('data_showvariable', {
        fields: {VARIABLE: 'v'},
        fieldIds: {VARIABLE: 'var-v'}
    });
    const clear = s.add('playgo_oledClear');
    s.chain([show, clear]);
    s.flag(show);

    const {warnings} = compile(s);
    t.ok(warnings.some(w => w.code === 'NO_EFFECT'));
    t.equal(run(s, 200).length, 1, 'el resto del programa corre igual');
    t.end();
});

// ── Programa completo ────────────────────────────────────────────────────

test('★ el programa insignia, ahora desde bloques de verdad', t => {
    const s = new Script();
    const motors = s.add('playgo_setMotorSpeeds', {
        inputs: {LEFT: s.num(50), RIGHT: s.num(50)}
    });
    const wait1 = s.add('control_wait', {inputs: {DURATION: s.num(1)}});
    const stop = s.add('playgo_stopMotors');
    const wait2 = s.add('control_wait', {inputs: {DURATION: s.num(1)}});
    s.chain([motors, wait1, stop, wait2]);

    const forever = s.add('control_forever', {inputs: {SUBSTACK: motors}});
    s.flag(forever);

    const {bytes, stats} = compile(s);
    t.ok(stats.programSize < 100, `el binario es diminuto (${stats.programSize} bytes)`);
    t.equal(stats.threads, 1);

    const vm = new ReferenceVM(bytes, {hwMap: playgo});
    vm.run(10000);

    const starts = vm.log.filter(l => l.hw === 'setMotorSpeed');
    const stops = vm.log.filter(l => l.hw === 'stopMotors');
    t.equal(starts.length, 5, 'cinco arranques en 10 s');
    t.equal(stops.length, 5);
    t.same(starts[0].args, [50, 50]);
    for (let i = 0; i < stops.length; i++) {
        t.equal(stops[i].t - starts[i].t, 1000, 'cada frenada llega 1 s tras su arranque');
    }
    t.end();
});
