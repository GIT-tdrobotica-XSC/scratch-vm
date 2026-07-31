/**
 * Tests del protocolo de subida (F2), contra una placa falsa.
 *
 * Cubren la cadena entera sin hardware: bloques -> bytecode -> troceado ->
 * base64 -> "firmware" -> NVS -> apagar y encender -> el programa sigue ahí.
 */

const test = require('tap').test;

const Blocks = require('../../src/engine/blocks');
const Runtime = require('../../src/engine/runtime');
const {compileBlocks} = require('../../src/compiler');
const {ISA_VERSION} = require('../../src/compiler/isa');
const ProgramUploader = require('../../src/extensions/common/program-uploader');
const {toBase64, CHUNK_SIZE, UploadError} = ProgramUploader;
const FakeBoard = require('../fixtures/fake-board');
const {fromBase64, MAX_LINE_CHARS} = FakeBoard;
const playgo = require('../../src/compiler/targets/playgo/hw-map');

/**
 * Conecta un uploader con una placa falsa.
 * @param {object} [boardOptions] Opciones de la placa.
 * @param {object} [uploaderOptions] Opciones del uploader.
 * @returns {object} `{board, uploader, io}`.
 */
const wire = function (boardOptions, uploaderOptions) {
    const board = new FakeBoard(Object.assign({boardId: playgo.boardId}, boardOptions));

    const io = {
        connected: true,
        lines: [],
        isConnected () {
            return this.connected;
        },
        send (line) {
            this.lines.push(line);
            // Asíncrono, como el transporte real.
            return Promise.resolve().then(() => board.receiveLine(line));
        }
    };

    const uploader = new ProgramUploader(io, Object.assign({
        transport: 'usb',
        boardId: playgo.boardId
    }, uploaderOptions));

    board.onLine = data => uploader.handleTelemetry(data);

    return {board, uploader, io};
};

/**
 * Compila un programa de ejemplo.
 * @param {number} [repeats] Cuántos bloques encadenar (para variar el tamaño).
 * @returns {Uint8Array} Binario.
 */
const sampleProgram = function (repeats) {
    const blocks = new Blocks(new Runtime());
    let n = 0;
    const uid = p => p + (n++);

    const add = (opcode, opts) => {
        const o = opts || {};
        const id = uid(opcode.replace(/[^a-z]/gi, ''));
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
    };
    const num = v => add('math_number', {fields: {NUM: v}, shadow: true});

    const chain = [];
    for (let i = 0; i < (repeats || 1); i++) {
        chain.push(add('playgo_setMotorSpeeds', {inputs: {LEFT: num(50), RIGHT: num(50)}}));
        chain.push(add('control_wait', {inputs: {DURATION: num(1)}}));
        chain.push(add('playgo_stopMotors'));
    }
    for (let i = 0; i < chain.length - 1; i++) {
        blocks.getBlock(chain[i]).next = chain[i + 1];
        blocks.getBlock(chain[i + 1]).parent = chain[i];
    }
    const hat = add('event_whenflagclicked', {topLevel: true});
    blocks.getBlock(hat).next = chain[0];
    blocks.getBlock(chain[0]).parent = hat;

    return compileBlocks(blocks, 'playgo').bytes;
};

// ── Base64 ───────────────────────────────────────────────────────────────

test('base64 ida y vuelta conserva los bytes exactos', t => {
    for (const length of [0, 1, 2, 3, 4, 5, 17, 64, 255, 384]) {
        const original = Uint8Array.from(
            Array.from({length}, (_, i) => (i * 37) % 256)
        );
        const restored = fromBase64(toBase64(original));
        t.same(Array.from(restored), Array.from(original), `longitud ${length}`);
    }
    t.end();
});

test('el relleno de base64 es el estándar', t => {
    t.equal(toBase64(Uint8Array.from([77, 97, 110])), 'TWFu', 'sin relleno');
    t.equal(toBase64(Uint8Array.from([77, 97])), 'TWE=', 'un signo igual');
    t.equal(toBase64(Uint8Array.from([77])), 'TQ==', 'dos signos igual');
    t.end();
});

// ── Subida completa ──────────────────────────────────────────────────────

test('★ subir un programa: llega intacto y queda guardado', async t => {
    const {board, uploader} = wire();
    const program = sampleProgram();

    const progress = [];
    const stats = await uploader.upload(program, {
        onProgress: fraction => progress.push(fraction)
    });

    t.equal(stats.size, program.length);
    t.same(Array.from(board.nvs.program), Array.from(program),
        'los bytes guardados son EXACTAMENTE los compilados');
    t.ok(board.storedProgramLooksValid(), 'la cabecera sobrevivió');
    t.equal(board.nvs.crc, stats.crc, 'el CRC coincide en ambos lados');
    t.ok(board.running, 'el programa quedó corriendo');

    t.ok(progress.length >= 2, 'se informó el progreso');
    t.equal(progress[progress.length - 1], 1, 'termina en 100%');
    t.end();
});

test('★ el programa sobrevive a apagar y encender la placa', async t => {
    const {board, uploader} = wire();
    const program = sampleProgram();
    await uploader.upload(program);

    board.powerCycle();

    t.ok(board.nvs.program, 'sigue en memoria persistente');
    t.same(Array.from(board.nvs.program), Array.from(program), 'y sin alterarse');
    t.ok(board.running, 'arrancó solo al encender');
    t.equal(board.status().st, 'running');
    t.end();
});

test('progInfo reporta lo que hay guardado', async t => {
    const {board, uploader} = wire();

    let info = await uploader.info();
    t.equal(info.st, 'empty', 'una placa nueva no tiene programa');

    const program = sampleProgram();
    await uploader.upload(program, {run: false});

    board.powerCycle();
    board.running = false;

    info = await uploader.info();
    t.equal(info.st, 'loaded');
    t.equal(info.sz, program.length, 'reporta el tamaño correcto');
    t.end();
});

// ── Troceado ─────────────────────────────────────────────────────────────

test('el troceado usa tamaños distintos para USB y para BLE', async t => {
    const big = sampleProgram(40);
    t.ok(big.length > CHUNK_SIZE.usb, `el programa de prueba es grande (${big.length} B)`);

    const usb = wire({}, {transport: 'usb'});
    const usbStats = await usb.uploader.upload(big);
    t.equal(usbStats.chunks, Math.ceil(big.length / CHUNK_SIZE.usb));

    const ble = wire({}, {transport: 'ble'});
    const bleStats = await ble.uploader.upload(big);
    t.equal(bleStats.chunks, Math.ceil(big.length / CHUNK_SIZE.ble));

    t.ok(bleStats.chunks > usbStats.chunks, 'BLE trocea más fino');
    t.same(Array.from(ble.board.nvs.program), Array.from(big),
        'por BLE también llega intacto');
    t.end();
});

test('ninguna línea desborda el buffer del firmware', async t => {
    // Este test es la red contra el fallo MÁS traicionero del protocolo: si un
    // trozo produce una línea más larga de lo que el firmware acepta, ésta se
    // descarta EN SILENCIO y la subida se queda colgada sin explicación.
    for (const transport of ['usb', 'ble']) {
        const {io, uploader} = wire({}, {transport});
        await uploader.upload(sampleProgram(40));

        const longest = io.lines.reduce((max, l) => Math.max(max, l.length), 0);
        t.ok(longest <= MAX_LINE_CHARS,
            `por ${transport} la línea más larga (${longest}) cabe en el buffer (${MAX_LINE_CHARS})`);
    }
    t.end();
});

test('un programa grande se reensambla en el orden correcto', async t => {
    const {board, uploader} = wire({}, {transport: 'ble'});
    const big = sampleProgram(40);
    await uploader.upload(big);

    t.same(Array.from(board.nvs.program), Array.from(big));
    t.same(board.chunksSeen, board.chunksSeen.slice().sort((a, b) => a - b),
        'los trozos llegaron en orden');
    t.end();
});

// ── Reintentos y fallos ──────────────────────────────────────────────────

test('un ack perdido se reintenta y la subida termina bien', async t => {
    const {board, uploader} = wire({}, {transport: 'ble'});
    const program = sampleProgram(20);

    // La placa se "come" el ack del trozo 2 la primera vez.
    board.dropAcksFor.add(2);

    const stats = await uploader.upload(program);

    t.same(Array.from(board.nvs.program), Array.from(program),
        'el reintento no corrompió nada (los trozos son idempotentes)');
    t.ok(board.chunksSeen.filter(s => s === 2).length >= 2, 'el trozo 2 se envió dos veces');
    t.equal(stats.size, program.length);
    t.end();
});

test('una placa con otra versión de ISA se rechaza con un mensaje claro', async t => {
    const {uploader} = wire({isa: ISA_VERSION + 1});

    await t.rejects(
        uploader.upload(sampleProgram()),
        UploadError,
        'la subida falla'
    );

    try {
        await uploader.upload(sampleProgram());
    } catch (err) {
        t.equal(err.reason, 'isa');
        t.match(err.message, /actualizar su firmware/,
            'el mensaje dice qué hacer, no "error 3"');
    }
    t.end();
});

test('un programa para otra placa se rechaza', async t => {
    const {uploader} = wire({boardId: 99});
    try {
        await uploader.upload(sampleProgram());
        t.fail('debió rechazarse');
    } catch (err) {
        t.equal(err.reason, 'board');
    }
    t.end();
});

test('si el programa llega corrupto, el CRC lo detecta y NO se guarda', async t => {
    const {board, uploader} = wire();

    // Se corrompe un byte al escribirlo en el buffer, como haría un trozo malo
    // que de algún modo pasara los acks.
    const originalSet = board._buf.set.bind(board._buf);
    let corrupted = false;
    board._buf.set = (bytes, offset) => {
        if (!corrupted && bytes.length > 4) {
            corrupted = true;
            const copy = Uint8Array.from(bytes);
            copy[2] ^= 0xFF;
            return originalSet(copy, offset);
        }
        return originalSet(bytes, offset);
    };

    try {
        await uploader.upload(sampleProgram());
        t.fail('debió detectarse la corrupción');
    } catch (err) {
        t.equal(err.reason, 'crc');
    }

    t.equal(board.nvs.program, null,
        'no se persiste nada corrupto: mejor sin programa que con uno roto');
    t.end();
});

test('si se pierde la conexión a mitad de subida, se avisa', async t => {
    const {io, uploader} = wire({}, {transport: 'ble'});
    const program = sampleProgram(30);

    let sent = 0;
    const realSend = io.send.bind(io);
    io.send = line => {
        if (++sent > 3) {
            io.connected = false;
            return Promise.reject(new Error('puerto cerrado'));
        }
        return realSend(line);
    };

    await t.rejects(uploader.upload(program), 'la subida falla en vez de colgarse');
    t.end();
});

test('un programa demasiado grande lo rechaza la placa', async t => {
    const {uploader} = wire();
    // 5 KB supera el tope que se persiste en NVS.
    const oversized = new Uint8Array(5000);

    try {
        await uploader.upload(oversized);
        t.fail('debió rechazarse');
    } catch (err) {
        t.equal(err.reason, 'size');
    }
    t.end();
});

// ── Modos de operación ───────────────────────────────────────────────────

test('con el programa corriendo, los comandos de hardware se ignoran', async t => {
    const {board, uploader, io} = wire();
    await uploader.upload(sampleProgram());
    t.ok(board.running);

    let warned = false;
    board.onLine = data => {
        if (data.prog && data.prog.warn === 'busy') warned = true;
        uploader.handleTelemetry(data);
    };

    await io.send(JSON.stringify({
        command: 'outputsQueue',
        testValue: [{command: 'setMotorSpeed', left: 100, right: 100}]
    }));

    t.ok(warned, 'la placa avisa que está ocupada en vez de obedecer');
    t.end();
});

test('detener y borrar dejan la placa limpia', async t => {
    const {board, uploader} = wire();
    await uploader.upload(sampleProgram());

    await uploader.stop();
    t.notOk(board.running, 'detenido');
    t.ok(board.nvs.program, 'pero el programa sigue guardado');

    await uploader.erase();
    t.equal(board.nvs.program, null, 'borrado');
    t.equal(board.status().st, 'empty');
    t.end();
});

test('subir de nuevo reemplaza el programa anterior', async t => {
    const {board, uploader} = wire();
    await uploader.upload(sampleProgram(1));
    const first = Array.from(board.nvs.program);

    const second = sampleProgram(5);
    await uploader.upload(second);

    t.notSame(Array.from(board.nvs.program), first, 'cambió');
    t.same(Array.from(board.nvs.program), Array.from(second), 'es el nuevo');
    t.end();
});

test('las esperas pendientes se cancelan al desconectar', async t => {
    const {uploader, io} = wire();
    io.send = () => Promise.resolve(); // la placa nunca contesta

    const pending = uploader.info();
    uploader.cancelPending();

    await t.rejects(pending, 'la promesa no se queda colgada para siempre');
    t.end();
});
