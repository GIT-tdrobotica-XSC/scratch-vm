/**
 * Serialización del binario de un programa compilado, y su parser inverso.
 *
 * Layout (todo little-endian):
 *
 *   Cabecera (16 B)   magic 'PCBC' | isaVersion | boardId | flags | numVars
 *                     | numThreads | numStrings | codeSize | headerCrc
 *   Strings           numStrings x { u16 len; u8 bytes[len] }   (UTF-8)
 *   Hilos             numThreads x { u8 hatKind; u16 entryPc }
 *   Código            codeSize bytes
 *   CRC               u16 sobre TODO lo anterior
 *
 * El `headerCrc` permite a la placa descartar basura evidente sin haber
 * recibido el programa entero; el CRC final valida la subida completa por
 * chunks antes de persistirla.
 *
 * `parseProgram()` no existe sólo para los tests: es la referencia ejecutable
 * del formato para quien implemente el lector en C++, y el intérprete de
 * referencia lo usa de verdad (así el formato se ejercita de punta a punta en
 * cada test, en vez de quedar sólo descrito en un documento).
 */

const {HEADER, HEADER_FLAGS, ISA_VERSION, THREAD_ENTRY_SIZE} = require('./isa');
const crc16 = require('./crc16');

// TextEncoder/TextDecoder son globales tanto en el navegador como en Node 11+,
// que son los dos entornos donde corre esto (la GUI y los tests).

/**
 * Codifica un string a UTF-8.
 * @param {string} str Texto.
 * @returns {Uint8Array} Bytes UTF-8.
 */
const encodeUtf8 = function (str) {
    return new TextEncoder().encode(str);
};

/**
 * Decodifica UTF-8 a string.
 * @param {Uint8Array} bytes Bytes UTF-8.
 * @returns {string} Texto.
 */
const decodeUtf8 = function (bytes) {
    return new TextDecoder('utf-8').decode(bytes);
};

/**
 * @typedef {object} ProgramParts
 * @property {number} boardId Id de la placa destino.
 * @property {Array.<string>} strings Tabla de textos.
 * @property {Array.<{hatKind: number, entryPc: number}>} threads Hilos.
 * @property {Uint8Array} code Código máquina.
 * @property {number} [numVars] Variables usadas.
 * @property {boolean} [autorun] Arrancar solo al encender (true por defecto).
 */

/**
 * Serializa un programa compilado a su forma binaria.
 * @param {ProgramParts} parts Piezas del programa.
 * @returns {Uint8Array} Binario listo para subir a la placa.
 */
const serializeProgram = function (parts) {
    const strings = parts.strings || [];
    const threads = parts.threads || [];
    const code = parts.code || new Uint8Array(0);
    const numVars = parts.numVars || 0;
    const autorun = parts.autorun !== false;

    const encodedStrings = strings.map(encodeUtf8);
    const stringTableSize = encodedStrings.reduce((sum, s) => sum + 2 + s.length, 0);
    const total = HEADER.SIZE +
        stringTableSize +
        (threads.length * THREAD_ENTRY_SIZE) +
        code.length +
        2; // CRC final

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    const off = HEADER.OFFSETS;

    // -- Cabecera --
    view.setUint32(off.magic, HEADER.MAGIC, true);
    out[off.isaVersion] = ISA_VERSION;
    out[off.boardId] = parts.boardId;
    view.setUint16(off.flags, autorun ? HEADER_FLAGS.AUTORUN : 0, true);
    view.setUint16(off.numVars, numVars, true);
    out[off.numThreads] = threads.length;
    out[off.numStrings] = strings.length;
    view.setUint16(off.codeSize, code.length, true);
    view.setUint16(off.headerCrc, crc16(out, 0, off.headerCrc), true);

    let pos = HEADER.SIZE;

    // -- Tabla de strings --
    for (const encoded of encodedStrings) {
        view.setUint16(pos, encoded.length, true);
        pos += 2;
        out.set(encoded, pos);
        pos += encoded.length;
    }

    // -- Tabla de hilos --
    for (const thread of threads) {
        out[pos] = thread.hatKind;
        view.setUint16(pos + 1, thread.entryPc, true);
        pos += THREAD_ENTRY_SIZE;
    }

    // -- Código --
    out.set(code, pos);
    pos += code.length;

    // -- CRC de todo lo anterior --
    view.setUint16(pos, crc16(out, 0, pos), true);

    return out;
};

/**
 * Lee un binario y devuelve sus piezas, validando magic, CRCs y consistencia
 * de tamaños.
 * @param {Uint8Array} bytes Binario.
 * @returns {object} Las piezas del programa, más `isaVersion`, `flags` y
 *     `autorun`.
 */
const parseProgram = function (bytes) {
    if (bytes.length < HEADER.SIZE + 2) {
        throw new Error('Binario demasiado corto para ser un programa');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = HEADER.OFFSETS;

    if (view.getUint32(off.magic, true) !== HEADER.MAGIC) {
        throw new Error('Magic inválido: esto no es un programa de PlayCode');
    }
    const expectedHeaderCrc = crc16(bytes, 0, off.headerCrc);
    if (view.getUint16(off.headerCrc, true) !== expectedHeaderCrc) {
        throw new Error('CRC de la cabecera no coincide');
    }

    const isaVersion = bytes[off.isaVersion];
    const boardId = bytes[off.boardId];
    const flags = view.getUint16(off.flags, true);
    const numVars = view.getUint16(off.numVars, true);
    const numThreads = bytes[off.numThreads];
    const numStrings = bytes[off.numStrings];
    const codeSize = view.getUint16(off.codeSize, true);

    let pos = HEADER.SIZE;

    const strings = [];
    for (let i = 0; i < numStrings; i++) {
        if (pos + 2 > bytes.length) throw new Error('Tabla de strings truncada');
        const len = view.getUint16(pos, true);
        pos += 2;
        if (pos + len > bytes.length) throw new Error('Tabla de strings truncada');
        strings.push(decodeUtf8(bytes.subarray(pos, pos + len)));
        pos += len;
    }

    const threads = [];
    for (let i = 0; i < numThreads; i++) {
        if (pos + THREAD_ENTRY_SIZE > bytes.length) throw new Error('Tabla de hilos truncada');
        threads.push({
            hatKind: bytes[pos],
            entryPc: view.getUint16(pos + 1, true)
        });
        pos += THREAD_ENTRY_SIZE;
    }

    if (pos + codeSize + 2 > bytes.length) throw new Error('Código truncado');
    const code = bytes.subarray(pos, pos + codeSize);
    pos += codeSize;

    const storedCrc = view.getUint16(pos, true);
    if (storedCrc !== crc16(bytes, 0, pos)) {
        throw new Error('CRC del programa no coincide: la subida llegó corrupta');
    }

    return {
        isaVersion,
        boardId,
        flags,
        autorun: (flags & HEADER_FLAGS.AUTORUN) !== 0,
        numVars,
        strings,
        threads,
        code
    };
};

module.exports = {
    serializeProgram,
    parseProgram
};
