/**
 * Integración de punta a punta: exactamente lo que hace la GUI cuando el
 * usuario pulsa "Subir a la placa".
 *
 * Recorre la cadena completa usando las APIs públicas reales
 * (`vm.createDeviceTarget`, `vm.compileDeviceProgram`, `peripheral.upload`)
 * contra la placa falsa, sin hardware.
 */

const test = require('tap').test;

const VirtualMachine = require('../../src/virtual-machine');
const ProgramUploader = require('../../src/extensions/common/program-uploader');
const FakeBoard = require('../fixtures/fake-board');
const playgo = require('../../src/compiler/targets/playgo/hw-map');
const ReferenceVM = require('../../src/compiler/reference-vm/vm');

/**
 * Crea una VM con un device target de PlayGo que contiene un programa.
 * @param {Function} build Recibe helpers y arma los bloques.
 * @returns {object} `{vm, targetId}`.
 */
const makeVmWithProgram = function (build) {
    const vm = new VirtualMachine();
    const targetId = vm.createDeviceTarget('playgo', 'PlayGo');
    const target = vm.runtime.getTargetById(targetId);
    const blocks = target.blocks;

    let n = 0;
    const helpers = {
        add (opcode, opts) {
            const o = opts || {};
            const id = `${opcode.replace(/[^a-z]/gi, '')}${n++}`;
            const fields = {};
            for (const k of Object.keys(o.fields || {})) fields[k] = {name: k, value: o.fields[k]};
            const inputs = {};
            for (const k of Object.keys(o.inputs || {})) {
                inputs[k] = {name: k, block: o.inputs[k], shadow: null};
            }
            blocks.createBlock({
                id,
                opcode,
                inputs,
                fields,
                next: null,
                topLevel: !!o.topLevel,
                shadow: !!o.shadow,
                parent: null
            });
            return id;
        },
        num (value) {
            return helpers.add('math_number', {fields: {NUM: value}, shadow: true});
        },
        chain (ids) {
            for (let i = 0; i < ids.length - 1; i++) {
                blocks.getBlock(ids[i]).next = ids[i + 1];
                blocks.getBlock(ids[i + 1]).parent = ids[i];
            }
        },
        flag (firstId) {
            const hat = helpers.add('event_whenflagclicked', {topLevel: true});
            blocks.getBlock(hat).next = firstId;
            blocks.getBlock(firstId).parent = hat;
            return hat;
        }
    };

    build(helpers);
    return {vm, targetId};
};

/**
 * Conecta un uploader a una placa falsa.
 * @returns {object} `{board, uploader}`.
 */
const makeBoard = function () {
    const board = new FakeBoard({boardId: playgo.boardId});
    const io = {
        isConnected: () => true,
        send: line => Promise.resolve().then(() => board.receiveLine(line))
    };
    const uploader = new ProgramUploader(io, {transport: 'usb', boardId: playgo.boardId});
    board.onLine = data => uploader.handleTelemetry(data);
    return {board, uploader};
};

test('★ el recorrido completo del botón "Subir a la placa"', async t => {
    // 1. El usuario arma un programa en el target del dispositivo.
    const {vm, targetId} = makeVmWithProgram(h => {
        const motors = h.add('playgo_setMotorSpeeds', {
            inputs: {LEFT: h.num(60), RIGHT: h.num(60)}
        });
        const wait = h.add('control_wait', {inputs: {DURATION: h.num(0.5)}});
        const stop = h.add('playgo_stopMotors');
        h.chain([motors, wait, stop]);
        const forever = h.add('control_forever', {inputs: {SUBSTACK: motors}});
        h.flag(forever);
    });

    // 2. La GUI compila con la API pública de la VM.
    const compiled = vm.compileDeviceProgram(targetId);
    t.ok(compiled.bytes.length > 0, 'produjo bytecode');
    t.equal(compiled.stats.threads, 1);
    t.same(compiled.warnings, [], 'sin avisos');

    // 3. Se sube a la placa.
    const {board, uploader} = makeBoard();
    const stats = await uploader.upload(compiled.bytes);

    t.same(Array.from(board.nvs.program), Array.from(compiled.bytes),
        'la placa guardó exactamente lo que compiló la VM');
    t.equal(stats.crc, board.nvs.crc);
    t.ok(board.running, 'quedó corriendo');

    // 4. Se desenchufa y se vuelve a encender: el programa sigue.
    board.powerCycle();
    t.ok(board.running, 'arranca solo tras el apagón');

    // 5. Lo que la placa guardó hace lo que el usuario dibujó.
    const sim = new ReferenceVM(board.nvs.program, {hwMap: playgo});
    sim.run(3000);
    const starts = sim.log.filter(l => l.hw === 'setMotorSpeed');
    t.ok(starts.length >= 2, 'el bucle se repite');
    t.same(starts[0].args, [60, 60], 'con la velocidad que puso el usuario');
    t.end();
});

test('un programa con un bloque de teclado no se sube y señala el bloque', t => {
    let keyBlockId = null;
    const {vm, targetId} = makeVmWithProgram(h => {
        keyBlockId = h.add('sensing_keypressed', {
            inputs: {KEY_OPTION: h.add('text', {fields: {TEXT: 'space'}, shadow: true})}
        });
        const body = h.add('playgo_stopMotors');
        const branch = h.add('control_if', {
            inputs: {CONDITION: keyBlockId, SUBSTACK: body}
        });
        h.flag(branch);
    });

    try {
        vm.compileDeviceProgram(targetId);
        t.fail('debió fallar');
    } catch (group) {
        t.equal(group.errors.length, 1);
        t.equal(group.errors[0].blockId, keyBlockId,
            'la GUI puede resaltar exactamente este bloque');
        t.match(group.errors[0].message, /necesita el computador/);
        t.ok(group.errors[0].hint, 'y le dice al niño qué usar en su lugar');
    }
    t.end();
});

test('compilar un target que no es un dispositivo se rechaza limpio', t => {
    const vm = new VirtualMachine();
    try {
        vm.compileDeviceProgram('no-existe');
        t.fail('debió fallar');
    } catch (group) {
        t.ok(group.errors, 'lanza un grupo de errores, no un array pelado');
        t.match(group.errors[0].message, /No encontré el dispositivo/);
    }
    t.end();
});

test('los avisos no impiden subir', async t => {
    const {vm, targetId} = makeVmWithProgram(h => {
        const clear = h.add('playgo_oledClear');
        h.flag(clear);
        // Un script suelto, sin bandera: sólo debe generar un aviso.
        h.add('playgo_stopMotors', {topLevel: true});
    });

    const compiled = vm.compileDeviceProgram(targetId);
    t.ok(compiled.warnings.length > 0, 'hay avisos');
    t.equal(compiled.stats.threads, 1);

    const {board, uploader} = makeBoard();
    await uploader.upload(compiled.bytes);
    t.ok(board.nvs.program, 'se subió igualmente');
    t.end();
});
