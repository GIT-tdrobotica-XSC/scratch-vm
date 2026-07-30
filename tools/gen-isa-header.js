#!/usr/bin/env node
/**
 * Genera el header C++ del intérprete de bytecode a partir de la fuente única
 * de verdad (`src/compiler/isa.js` + los hw-map de cada placa).
 *
 *   node tools/gen-isa-header.js            escribe el header
 *   node tools/gen-isa-header.js --check    falla si el header versionado
 *                                           no coincide con la fuente
 *
 * El modo `--check` está enganchado a `npm test`: si alguien toca la ISA y no
 * regenera, la suite falla. Es la capa 1 de las cuatro que protegen contra que
 * el compilador (JS) y el intérprete (C++) se desincronicen en silencio -- el
 * riesgo número uno de todo este diseño, porque se manifiesta como un robot
 * haciendo algo distinto de lo que el niño programó.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isa = require('../src/compiler/isa');
const playgo = require('../src/compiler/targets/playgo/hw-map');

const BOARDS = [playgo];

const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'compiler', 'generated', 'playcode_isa.h');
const ISA_SOURCE_PATH = path.join(__dirname, '..', 'src', 'compiler', 'isa.js');

/**
 * Convierte un nombre camelCase a MAYUSCULAS_CON_GUION_BAJO.
 * @param {string} name Nombre en camelCase.
 * @returns {string} Nombre en SCREAMING_SNAKE_CASE.
 */
const screamingSnake = function (name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toUpperCase();
};

/**
 * @param {number} value Número.
 * @param {number} width Dígitos hexadecimales.
 * @returns {string} Literal hexadecimal C.
 */
const hex = function (value, width) {
    return `0x${value.toString(16).toUpperCase()
        .padStart(width || 2, '0')}`;
};

/**
 * Construye el contenido completo del header.
 * @returns {string} Código C++.
 */
const buildHeader = function () {
    const isaSource = fs.readFileSync(ISA_SOURCE_PATH, 'utf8');
    const sha = crypto.createHash('sha256').update(isaSource)
        .digest('hex');

    const lines = [];
    const w = line => lines.push(line);

    w('/* =====================================================================');
    w(' *  ARCHIVO GENERADO -- NO EDITAR A MANO');
    w(' *');
    w(' *  Fuente:    scratch-vm/src/compiler/isa.js');
    w(' *  Regenerar: npm run isa:gen      (dentro de scratch-vm)');
    w(' *  Verificar: npm run isa:check    (corre solo en npm test)');
    w(' *');
    w(`ID *  sha256 de la fuente: ${sha}`.replace('ID *', ' *'));
    w(' *');
    w(' *  Si editas este archivo a mano, el siguiente `npm test` fallara.');
    w(' *  Cambia isa.js y regenera.');
    w(' * ===================================================================== */');
    w('');
    w('#ifndef PLAYCODE_ISA_H');
    w('#define PLAYCODE_ISA_H');
    w('');
    w('#include <stdint.h>');
    w('');
    w('/* Version del juego de instrucciones. La placa la reporta en su');
    w(' * telemetria ("isa":N) y la valida al recibir un programa. */');
    w(`#define PC_ISA_VERSION ${isa.ISA_VERSION}`);
    w('');

    w('/* Identificadores de placa (van en la cabecera del programa). */');
    for (const name of Object.keys(isa.BOARD_IDS)) {
        w(`#define PC_BOARD_${screamingSnake(name)} ${isa.BOARD_IDS[name]}`);
    }
    w('');

    w('/* Layout de la cabecera (16 bytes, little-endian). */');
    w(`#define PC_MAGIC ${hex(isa.HEADER.MAGIC, 8)}  /* 'PCBC' */`);
    w(`#define PC_HEADER_SIZE ${isa.HEADER.SIZE}`);
    w(`#define PC_THREAD_ENTRY_SIZE ${isa.THREAD_ENTRY_SIZE}`);
    for (const field of Object.keys(isa.HEADER.OFFSETS)) {
        w(`#define PC_OFF_${screamingSnake(field)} ${isa.HEADER.OFFSETS[field]}`);
    }
    w('');

    w('/* Banderas de la cabecera. */');
    for (const name of Object.keys(isa.HEADER_FLAGS)) {
        w(`#define PC_FLAG_${screamingSnake(name)} ${hex(isa.HEADER_FLAGS[name], 4)}`);
    }
    w('');

    w('/* Opcodes. */');
    w('enum PcOp {');
    const opNames = Object.keys(isa.OPCODES);
    opNames.forEach((name, i) => {
        const comma = i === opNames.length - 1 ? '' : ',';
        w(`    PC_OP_${screamingSnake(name)} = ${hex(isa.OPCODES[name])}${comma}`);
    });
    w('};');
    w('');

    w('/* Funciones de operator_mathop, en el orden que numera el bytecode. */');
    w('enum PcMathOp {');
    isa.MATHOP_FUNCTIONS.forEach((fn, i) => {
        const comma = i === isa.MATHOP_FUNCTIONS.length - 1 ? '' : ',';
        w(`    PC_MATHOP_${screamingSnake(fn)} = ${i}${comma}`);
    });
    w('};');
    w('');

    w('/* Modos de control_stop. */');
    for (const name of Object.keys(isa.STOP_MODES)) {
        w(`#define PC_STOP_${screamingSnake(name)} ${isa.STOP_MODES[name]}`);
    }
    w('');

    w('/* Tipos de sombrero (bloque de inicio) de cada hilo. */');
    for (const name of Object.keys(isa.HAT_KINDS)) {
        w(`#define PC_HAT_${screamingSnake(name)} ${isa.HAT_KINDS[name]}`);
    }
    w('');

    w('/* Codigos de error de ejecucion, reportados en {"prog":{"err":N}}. */');
    w('enum PcError {');
    const errNames = Object.keys(isa.RUNTIME_ERRORS);
    errNames.forEach((name, i) => {
        const comma = i === errNames.length - 1 ? '' : ',';
        w(`    PC_ERR_${screamingSnake(name)} = ${isa.RUNTIME_ERRORS[name]}${comma}`);
    });
    w('};');
    w('');

    for (const board of BOARDS) {
        const prefix = screamingSnake(board.boardName);
        const names = Object.keys(board.HW);
        const maxId = names.reduce((m, n) => Math.max(m, board.HW[n].id), 0);

        w(`/* ---- Primitivas de hardware: ${board.boardName} ---- */`);
        w(`enum PcHw${board.boardName.charAt(0).toUpperCase()}${board.boardName.slice(1)} {`);
        names.forEach((name, i) => {
            const spec = board.HW[name];
            const comma = i === names.length - 1 ? '' : ',';
            const pending = spec.needsFirmware ? '  /* FALTA EN EL FIRMWARE */' : '';
            w(`    PC_HW_${prefix}_${screamingSnake(name)} = ${hex(spec.id)}${comma}${pending}`);
        });
        w('};');
        w('');

        w('/* Aridad de cada primitiva, indexada por id. El interprete DEBE');
        w(' * verificar que el argc de la instruccion coincida y abortar con');
        w(' * PC_ERR_ARITY si no: es lo que convierte una desincronizacion de');
        w(' * tablas en un error limpio en vez de una pila corrupta moviendo');
        w(' * motores al azar. Un 0xFF marca un id no asignado. */');
        const argcTable = new Array(maxId + 1).fill('0xFF');
        for (const name of names) argcTable[board.HW[name].id] = String(board.HW[name].argc);
        w(`static const uint8_t PC_HW_ARGC_${prefix}[] = {`);
        for (let i = 0; i < argcTable.length; i += 8) {
            w(`    ${argcTable.slice(i, i + 8).join(', ')}${i + 8 < argcTable.length ? ',' : ''}`);
        }
        w('};');
        w(`#define PC_HW_COUNT_${prefix} ${names.length}`);
        w(`#define PC_HW_MAX_ID_${prefix} ${hex(maxId)}`);
        w('');
    }

    w('#endif /* PLAYCODE_ISA_H */');
    w('');

    return lines.join('\n');
};

const content = buildHeader();
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
    let current = null;
    try {
        current = fs.readFileSync(OUTPUT_PATH, 'utf8');
    } catch (e) {
        console.error(`✗ Falta ${path.relative(process.cwd(), OUTPUT_PATH)}. Corre: npm run isa:gen`);
        process.exit(1);
    }
    if (current !== content) {
        console.error(
            '✗ playcode_isa.h no coincide con src/compiler/isa.js.\n' +
            '  La ISA cambio y el header no se regenero (o se edito a mano).\n' +
            '  Corre: npm run isa:gen'
        );
        process.exit(1);
    }
    console.log('✓ playcode_isa.h esta sincronizado con isa.js');
} else {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), {recursive: true});
    fs.writeFileSync(OUTPUT_PATH, content, 'utf8');
    console.log(`✓ Generado ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}
