const test = require('tap').test;

const isa = require('../../src/compiler/isa');
const crc16 = require('../../src/compiler/crc16');
const Emitter = require('../../src/compiler/emitter');
const {serializeProgram, parseProgram} = require('../../src/compiler/serialize');
const playgo = require('../../src/compiler/targets/playgo/hw-map');

test('la ISA no tiene opcodes duplicados', t => {
    const seen = {};
    for (const name of Object.keys(isa.OPCODES)) {
        const value = isa.OPCODES[name];
        t.equal(seen[value], undefined,
            `el opcode ${isa.OPCODES[name]} de ${name} choca con ${seen[value]}`);
        seen[value] = name;
    }
    t.end();
});

test('todo opcode con operandos declarados existe en OPCODES', t => {
    for (const name of Object.keys(isa.OPERANDS)) {
        t.type(isa.OPCODES[name], 'number', `${name} debe existir en OPCODES`);
        for (const kind of isa.OPERANDS[name]) {
            t.type(isa.OPERAND_SIZES[kind], 'number', `tipo de operando conocido: ${kind}`);
        }
    }
    t.end();
});

test('instructionSize cuenta opcode + operandos', t => {
    t.equal(isa.instructionSize('YIELD'), 1);
    t.equal(isa.instructionSize('PUSH_I8'), 2);
    t.equal(isa.instructionSize('JMP'), 3);
    t.equal(isa.instructionSize('CALL_HW'), 3);
    t.equal(isa.instructionSize('PUSH_F32'), 5);
    t.end();
});

test('el mapa de hardware de PlayGo no tiene ids duplicados', t => {
    const seen = {};
    for (const name of Object.keys(playgo.HW)) {
        const {id} = playgo.HW[name];
        t.equal(seen[id], undefined, `el id 0x${id.toString(16)} de ${name} choca con ${seen[id]}`);
        seen[id] = name;
    }
    t.end();
});

test('cada primitiva de hardware declara tantos nombres de argumento como argc', t => {
    for (const name of Object.keys(playgo.HW)) {
        const spec = playgo.HW[name];
        t.equal(spec.args.length, spec.argc, `${name}: args coincide con argc`);
        t.ok(['cmd', 'reporter', 'wait'].includes(spec.kind), `${name}: kind válido`);
    }
    t.end();
});

test('CRC16-CCITT da el valor de referencia conocido', t => {
    // Vector estándar: "123456789" -> 0x29B1. Sirve para verificar que la
    // implementación del firmware en C++ coincide con ésta.
    const bytes = Uint8Array.from('123456789'.split('').map(c => c.charCodeAt(0)));
    t.equal(crc16(bytes), 0x29B1);
    t.end();
});

test('el emisor resuelve saltos hacia adelante y hacia atrás', t => {
    const e = new Emitter();
    const start = e.label('inicio');
    const end = e.label('fin');

    e.place(start);
    e.emit('PUSH_TRUE', [], 1);
    e.emitJump('JZ', end, -1);
    e.emit('NOP');
    e.emitJump('JMP', start);
    e.place(end);
    e.emit('HALT');

    const code = e.finish();

    // JZ está en 1; su operando en 2; la siguiente instrucción en 4.
    // El destino (fin) es 8 -> desplazamiento +4.
    t.equal(code[2] | (code[3] << 8), 4, 'salto adelante correcto');

    // JMP está en 5; siguiente instrucción en 8; destino 0 -> -8.
    const raw = code[6] | (code[7] << 8);
    t.equal(raw > 32767 ? raw - 65536 : raw, -8, 'salto atrás correcto');
    t.end();
});

test('el emisor detecta una etiqueta sin ubicar (bug del compilador)', t => {
    const e = new Emitter();
    e.emitJump('JMP', e.label('perdida'));
    t.throws(() => e.finish(), /Etiqueta sin ubicar/);
    t.end();
});

test('el emisor lleva la cuenta de la profundidad máxima de pila', t => {
    const e = new Emitter({maxStackDepth: 2});
    e.emit('PUSH_I8', [1], 1);
    e.emit('PUSH_I8', [2], 1);
    t.equal(e.maxStackReached, 2);
    t.notOk(e.stackOverflowed(), 'dentro del límite');

    e.emit('PUSH_I8', [3], 1);
    t.ok(e.stackOverflowed(), 'se detecta el exceso estáticamente');
    t.end();
});

test('serializar y parsear conserva todas las piezas', t => {
    const code = Uint8Array.from([isa.OPCODES.HALT]);
    const binary = serializeProgram({
        boardId: playgo.boardId,
        strings: ['Hola', 'ñandú'],
        threads: [{hatKind: isa.HAT_KINDS.whenFlagClicked, entryPc: 0}],
        code,
        numVars: 3
    });

    const parsed = parseProgram(binary);
    t.equal(parsed.isaVersion, isa.ISA_VERSION);
    t.equal(parsed.boardId, playgo.boardId);
    t.equal(parsed.numVars, 3);
    t.same(parsed.strings, ['Hola', 'ñandú'], 'los textos sobreviven en UTF-8');
    t.equal(parsed.threads.length, 1);
    t.equal(parsed.threads[0].entryPc, 0);
    t.same(Array.from(parsed.code), [isa.OPCODES.HALT]);
    t.ok(parsed.autorun, 'autoarranque activado por defecto');
    t.end();
});

test('un bit alterado hace fallar el CRC', t => {
    const binary = serializeProgram({
        boardId: playgo.boardId,
        strings: [],
        threads: [{hatKind: 0, entryPc: 0}],
        code: Uint8Array.from([isa.OPCODES.NOP, isa.OPCODES.HALT]),
        numVars: 0
    });

    // Corromper un byte del código, como haría una subida con un chunk malo.
    const corrupted = binary.slice();
    corrupted[binary.length - 4] ^= 0x01;
    t.throws(() => parseProgram(corrupted), /CRC del programa/);
    t.end();
});

test('un programa que no es de PlayCode se rechaza por el magic', t => {
    const junk = new Uint8Array(32);
    t.throws(() => parseProgram(junk), /Magic inválido/);
    t.end();
});
