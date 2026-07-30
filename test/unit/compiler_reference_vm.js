/**
 * Tests del intérprete de referencia.
 *
 * Estos tests son, además de tests, la ESPECIFICACIÓN de lo que debe hacer el
 * intérprete en C++ del firmware. Quien porte `vm.cpp` debería poder reproducir
 * cada uno de estos casos y obtener exactamente los mismos registros de
 * hardware con las mismas marcas de tiempo.
 */

const test = require('tap').test;

const {HAT_KINDS, STOP_MODES, RUNTIME_ERRORS} = require('../../src/compiler/isa');
const Emitter = require('../../src/compiler/emitter');
const {serializeProgram} = require('../../src/compiler/serialize');
const ReferenceVM = require('../../src/compiler/reference-vm/vm');
const V = require('../../src/compiler/reference-vm/values');
const playgo = require('../../src/compiler/targets/playgo/hw-map');

/**
 * Empaqueta código en un programa de un solo hilo.
 * @param {Uint8Array} code Código máquina.
 * @param {object} [extra] Piezas adicionales (strings, numVars...).
 * @returns {Uint8Array} Binario.
 */
const singleThread = function (code, extra) {
    return serializeProgram(Object.assign({
        boardId: playgo.boardId,
        strings: [],
        threads: [{hatKind: HAT_KINDS.whenFlagClicked, entryPc: 0}],
        code,
        numVars: 0
    }, extra || {}));
};

/**
 * Sink de hardware para los tests: registra y devuelve valores guionados.
 * @param {object} [scripted] Nombre de primitiva -> valor o función(t, args).
 * @returns {object} Sink con `call()`.
 */
const makeHardware = function (scripted) {
    const table = scripted || {};
    return {
        vm: null,
        call (name, args) {
            const entry = table[name];
            if (typeof entry === 'function') return entry(this.vm ? this.vm.now : 0, args);
            if (typeof entry !== 'undefined') return entry;
            return 0;
        }
    };
};

test('★ programa insignia: motores 50/50, esperar 1s, detener, esperar 1s, por siempre', t => {
    const e = new Emitter();
    const top = e.label('top');

    e.place(top);
    e.emit('PUSH_I8', [50], 1);
    e.emit('PUSH_I8', [50], 1);
    e.emit('CALL_HW', [playgo.HW.setMotorSpeed.id, 2], -2);
    e.emit('PUSH_F32', [1.0], 1);
    e.emit('WAIT', [], -1);
    e.emit('CALL_HW', [playgo.HW.stopMotors.id, 0]);
    e.emit('PUSH_F32', [1.0], 1);
    e.emit('WAIT', [], -1);
    e.emit('YIELD');
    e.emitJump('JMP', top);

    const code = e.finish();

    // -- Comprobación byte a byte: fija el formato para el firmware --
    t.same(Array.from(code), [
        0x02, 50, // PUSH_I8 50
        0x02, 50, // PUSH_I8 50
        0x70, 0x01, 0x02, // CALL_HW setMotorSpeed, 2
        0x01, 0x00, 0x00, 0x80, 0x3F, // PUSH_F32 1.0
        0x61, // WAIT
        0x70, 0x02, 0x00, // CALL_HW stopMotors, 0
        0x01, 0x00, 0x00, 0x80, 0x3F, // PUSH_F32 1.0
        0x61, // WAIT
        0x60, // YIELD
        0x50, 0xE6, 0xFF // JMP -26
    ], 'el bytecode coincide byte a byte con el del diseño');
    t.equal(code.length, 26, '26 bytes de código');

    const binary = singleThread(code);
    t.equal(binary.length, 47, '47 bytes de binario total (cabe en un solo chunk)');

    // -- Comprobación semántica: qué haría el robot --
    const vm = new ReferenceVM(binary, {hwMap: playgo});
    vm.run(10000);

    const motors = vm.log.filter(entry => entry.hw === 'setMotorSpeed');
    const stops = vm.log.filter(entry => entry.hw === 'stopMotors');

    t.equal(motors.length, 5, 'cinco arranques en 10 s');
    t.equal(stops.length, 5, 'cinco frenadas en 10 s');
    t.same(motors[0].args, [50, 50], 'los motores reciben 50/50');
    t.equal(motors[0].t, 0, 'el primer arranque es inmediato');

    // "esperar 1 segundo" debe durar EXACTAMENTE un segundo: eso es semántica,
    // no tolerancia.
    for (let i = 0; i < stops.length; i++) {
        t.equal(stops[i].t - motors[i].t, 1000, `la frenada ${i} llega 1 s tras el arranque`);
    }

    // El periodo completo es de ~2 s, con la pequeña deriva que también tiene
    // la placa real (cada `wait` se cuenta desde que el hilo despierta, no
    // desde cuando debió despertar).
    for (let i = 1; i < motors.length; i++) {
        const period = motors[i].t - motors[i - 1].t;
        t.ok(period >= 2000 && period <= 2100,
            `el ciclo ${i} dura ~2 s (fue ${period} ms)`);
    }
    t.end();
});

test('repetir: 0 y negativo no iteran, 2.6 redondea a 3 (como Scratch)', t => {
    const build = function (times) {
        const e = new Emitter();
        const body = e.label('body');
        const done = e.label('done');

        e.emit('PUSH_F32', [times], 1);
        e.emit('REPEAT_SETUP', [], -1);
        e.place(body);
        e.emitJump('LOOP_TEST', done);
        e.emit('CALL_HW', [playgo.HW.stopMotors.id, 0]);
        e.emit('YIELD');
        e.emitJump('LOOP_NEXT', body);
        e.place(done);
        e.emit('HALT');

        const vm = new ReferenceVM(singleThread(e.finish()), {hwMap: playgo});
        vm.run(1000);
        return vm.log.filter(entry => entry.hw === 'stopMotors').length;
    };

    t.equal(build(3), 3, 'repetir 3 -> 3 iteraciones');
    t.equal(build(0), 0, 'repetir 0 -> ninguna');
    t.equal(build(-3), 0, 'repetir -3 -> ninguna');
    t.equal(build(2.6), 3, 'repetir 2.6 -> 3 (Scratch redondea)');
    t.end();
});

test('dos "por siempre" en paralelo avanzan sin que ninguno se muera de hambre', t => {
    // Hilo A: motores cada 1 s. Hilo B: LED cada 0.4 s.
    const e = new Emitter();

    const aTop = e.label('a');
    e.place(aTop);
    e.emit('PUSH_I8', [10], 1);
    e.emit('PUSH_I8', [10], 1);
    e.emit('CALL_HW', [playgo.HW.setMotorSpeed.id, 2], -2);
    e.emit('PUSH_F32', [1.0], 1);
    e.emit('WAIT', [], -1);
    e.emit('YIELD');
    e.emitJump('JMP', aTop);

    e.resetStack();
    const bTop = e.label('b');
    const bEntry = e.pc;
    e.place(bTop);
    e.emit('PUSH_I8', [0], 1);
    e.emit('PUSH_I8', [255], 1);
    e.emit('PUSH_I8', [0], 1);
    e.emit('PUSH_I8', [0], 1);
    e.emit('CALL_HW', [playgo.HW.setRGB.id, 4], -4);
    e.emit('PUSH_F32', [0.4], 1);
    e.emit('WAIT', [], -1);
    e.emit('YIELD');
    e.emitJump('JMP', bTop);

    const binary = serializeProgram({
        boardId: playgo.boardId,
        strings: [],
        threads: [
            {hatKind: HAT_KINDS.whenFlagClicked, entryPc: 0},
            {hatKind: HAT_KINDS.whenFlagClicked, entryPc: bEntry}
        ],
        code: e.finish(),
        numVars: 0
    });

    const vm = new ReferenceVM(binary, {hwMap: playgo});
    vm.run(4000);

    const motors = vm.log.filter(entry => entry.hw === 'setMotorSpeed');
    const leds = vm.log.filter(entry => entry.hw === 'setRGB');

    // Lo que importa no es el conteo exacto (la deriva es real), sino que cada
    // hilo mantenga su propio ritmo y que el rápido no ahogue al lento.
    t.ok(motors.length >= 3 && motors.length <= 5,
        `el hilo lento corre a ~1 Hz (fueron ${motors.length} en 4 s)`);
    t.ok(leds.length >= 8 && leds.length <= 11,
        `el hilo rápido corre a ~2.5 Hz (fueron ${leds.length} en 4 s)`);
    t.ok(leds.length > motors.length, 'el rápido va más veces que el lento');

    // Ninguno se queda sin avanzar en ninguna ventana de 1 s.
    for (let window = 0; window < 4; window++) {
        const from = window * 1000;
        const to = from + 1000;
        t.ok(motors.some(m => m.t >= from && m.t < to), `motores avanzan en [${from},${to})`);
        t.ok(leds.some(l => l.t >= from && l.t < to), `LED avanza en [${from},${to})`);
    }
    t.end();
});

test('esperar hasta <sensor> reanuda cuando el sensor cambia, no antes', t => {
    const e = new Emitter();
    const loop = e.label('loop');
    const done = e.label('done');

    e.place(loop);
    e.emit('PUSH_I8', [0], 1);
    e.emit('CALL_HW_R', [playgo.HW.readButton.id, 1], 0); // pop 1, push 1
    e.emitJump('JNZ', done, -1);
    e.emit('YIELD');
    e.emitJump('JMP', loop);
    e.place(done);
    e.emit('CALL_HW', [playgo.HW.stopMotors.id, 0]);
    e.emit('HALT');

    const hardware = makeHardware({
        // El botón se presiona a los 750 ms de tiempo virtual.
        readButton: now => (now >= 750 ? 1 : 0)
    });
    const vm = new ReferenceVM(singleThread(e.finish()), {hwMap: playgo, hardware});
    hardware.vm = vm;
    vm.run(5000);

    const stop = vm.log.find(entry => entry.hw === 'stopMotors');
    t.ok(stop, 'el programa continuó tras la espera');
    t.ok(stop.t >= 750, 'no reanudó antes de que el botón se presionara');
    t.end();
});

test('detener [todos] mata los dos hilos y hace el apagado seguro', t => {
    const e = new Emitter();

    // Hilo A: detiene todo de inmediato.
    e.emit('STOP', [STOP_MODES.all]);

    e.resetStack();
    const bEntry = e.pc;
    const bTop = e.label('b');
    e.place(bTop);
    e.emit('CALL_HW', [playgo.HW.stopMotors.id, 0]);
    e.emit('YIELD');
    e.emitJump('JMP', bTop);

    const binary = serializeProgram({
        boardId: playgo.boardId,
        strings: [],
        threads: [
            {hatKind: HAT_KINDS.whenFlagClicked, entryPc: 0},
            {hatKind: HAT_KINDS.whenFlagClicked, entryPc: bEntry}
        ],
        code: e.finish(),
        numVars: 0
    });

    const vm = new ReferenceVM(binary, {hwMap: playgo});
    vm.run(1000);

    t.notOk(vm.isRunning(), 'ningún hilo quedó vivo');
    t.ok(vm.log.some(entry => entry.hw === 'safeStop'), 'se hizo el apagado seguro');
    t.end();
});

test('los reporters de hardware empujan su valor a la pila', t => {
    const e = new Emitter();
    e.emit('PUSH_I8', [1], 1);
    e.emit('CALL_HW_R', [playgo.HW.readAnalog.id, 1], 0);
    e.emit('STORE_VAR', [0], -1);
    e.emit('HALT');

    const hardware = makeHardware({readAnalog: 2048});
    const vm = new ReferenceVM(
        singleThread(e.finish(), {numVars: 1}),
        {hwMap: playgo, hardware}
    );
    vm.run(100);

    t.equal(vm.vars[0].num, 2048, 'la lectura quedó guardada en la variable');
    t.end();
});

test('una aridad que no coincide aborta limpio (protege de tablas desincronizadas)', t => {
    const e = new Emitter();
    e.emit('PUSH_I8', [1], 1);
    // setMotorSpeed espera 2 argumentos; declaramos 1 a propósito.
    e.emit('CALL_HW', [playgo.HW.setMotorSpeed.id, 1], -1);
    e.emit('HALT');

    const vm = new ReferenceVM(singleThread(e.finish()), {hwMap: playgo});
    vm.run(100);

    t.equal(vm.error, RUNTIME_ERRORS.ARITY,
        'aborta con ERR_ARITY en vez de corromper la pila');
    t.end();
});

test('CALL_HW_WAIT duerme el hilo hasta que la operación termina', t => {
    const e = new Emitter();
    e.emit('PUSH_F32', [20], 1); // distanceCm
    e.emit('PUSH_I8', [60], 1); // speed
    e.emit('PUSH_F32', [6.5], 1); // wheelDiameterCm
    e.emit('PUSH_I8', [20], 1); // pulsesPerRev
    e.emit('CALL_HW_WAIT', [playgo.HW.moveDistance.id, 4], -4);
    e.emit('CALL_HW', [playgo.HW.stopMotors.id, 0]);
    e.emit('HALT');

    // El movimiento simulado tarda 1.5 s.
    const hardware = makeHardware({moveDistance: 1500});
    const vm = new ReferenceVM(singleThread(e.finish()), {hwMap: playgo, hardware});
    vm.run(10000);

    const move = vm.log.find(entry => entry.hw === 'moveDistance');
    const stop = vm.log.find(entry => entry.hw === 'stopMotors');
    t.same(move.args, [20, 60, 6.5, 20], 'los argumentos llegan en orden');
    t.equal(move.t, 0, 'el movimiento arranca de inmediato');
    t.equal(stop.t, 1500, 'lo siguiente espera a que el movimiento termine');
    t.end();
});

test('las coerciones siguen la semántica de Scratch', t => {
    t.equal(V.toNumber(V.str('42')), 42, 'texto numérico -> número');
    t.equal(V.toNumber(V.str('hola')), 0, 'texto no numérico -> 0');
    t.equal(V.toNumber(V.bool(true)), 1);
    t.equal(V.toString(V.bool(true)), 'true', 'los booleanos son "true"/"false", no 1/0');
    t.notOk(V.toBoolean(V.str('')), 'cadena vacía es falsy');
    t.notOk(V.toBoolean(V.str('0')), '"0" es falsy');
    t.notOk(V.toBoolean(V.str('FALSE')), '"false" es falsy sin importar mayúsculas');
    t.ok(V.toBoolean(V.str('hola')), 'cualquier otro texto es truthy');
    t.equal(V.compare(V.str('10'), V.num(9)), 1, 'compara numéricamente si puede');
    t.equal(V.compare(V.str('ABC'), V.str('abc')), 0, 'texto sin distinguir mayúsculas');
    t.end();
});
