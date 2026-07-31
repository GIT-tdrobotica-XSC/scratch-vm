/**
 * Placa falsa que habla el protocolo de subida de programas.
 *
 * Sirve para dos cosas:
 *   1. Probar el uploader de punta a punta sin hardware.
 *   2. Ser la ESPECIFICACIÓN EJECUTABLE del lado del firmware: quien
 *      implemente `prog*` en `processSubcommand()` puede leer esto y saber
 *      exactamente qué debe contestar en cada caso, incluidos los rechazos.
 *
 * Reproduce también los LÍMITES REALES del firmware (tamaño del documento
 * JSON, tope del buffer de línea), porque pasarse de ellos es la forma más
 * fácil de perder trozos en silencio.
 */

const crc16 = require('../../src/compiler/crc16');
const {ISA_VERSION, HEADER} = require('../../src/compiler/isa');

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodifica base64 a bytes.
 * @param {string} text Texto base64.
 * @returns {Uint8Array} Bytes.
 */
const fromBase64 = function (text) {
    const clean = text.replace(/[=]+$/, '');
    const out = [];
    let bits = 0;
    let acc = 0;
    for (const ch of clean) {
        const value = B64_ALPHABET.indexOf(ch);
        if (value < 0) continue;
        acc = (acc << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xFF);
        }
    }
    return Uint8Array.from(out);
};

/** Tamaño máximo de un trozo que el firmware acepta, en bytes de programa. */
const MAX_CHUNK_BYTES = 512;

/** Lo que cabe en el buffer de línea del firmware (tras subirlo en F2). */
const MAX_LINE_CHARS = 2048;

/** RAM de recepción del firmware. */
const PROG_BUF_SIZE = 8192;

/** Tope de lo que se persiste en NVS. */
const MAX_PERSISTED = 4096;

class FakeBoard {
    /**
     * @param {object} [options] Opciones.
     * @param {number} [options.boardId] Id de placa que dice ser.
     * @param {number} [options.isa] Versión de ISA del "firmware".
     */
    constructor (options) {
        const opts = options || {};
        this.boardId = typeof opts.boardId === 'number' ? opts.boardId : 1;
        this.isa = typeof opts.isa === 'number' ? opts.isa : ISA_VERSION;

        /** Memoria persistente: sobrevive a `powerCycle()`. */
        this.nvs = {program: null, crc: 0, autorun: true};

        /** Buffer de recepción (RAM). */
        this._buf = new Uint8Array(PROG_BUF_SIZE);
        this._expected = null;

        this.running = false;
        this.error = 0;

        /** Diagnóstico para los tests. */
        this.received = [];
        this.chunksSeen = [];

        /** Trozos cuyo ack se va a "perder" a propósito (para probar reintentos). */
        this.dropAcksFor = new Set();

        /** Respuestas emitidas; el test las enruta de vuelta al uploader. */
        this.onLine = null;
    }

    /**
     * Recibe una línea del protocolo, como haría `handleLine()`.
     * @param {string} line Línea JSON.
     */
    receiveLine (line) {
        // El firmware descarta la línea si desborda su buffer. Sin este
        // límite reproducido aquí, un tamaño de trozo mal elegido pasaría los
        // tests y fallaría en la placa real, en silencio.
        if (line.length > MAX_LINE_CHARS) {
            this._reply({prog: {ack: 'chunk', ok: 0, err: 'toobig'}});
            return;
        }

        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        const commands = msg.testValue || [];
        for (const cmd of commands) this._process(cmd);
    }

    /**
     * @param {object} cmd Subcomando.
     */
    _process (cmd) {
        this.received.push(cmd.command);

        switch (cmd.command) {
        case 'progBegin':
            this._begin(cmd);
            break;
        case 'progChunk':
            this._chunk(cmd);
            break;
        case 'progEnd':
            this._end();
            break;
        case 'progRun':
            this.running = !!this.nvs.program;
            this._reply({prog: {ack: 'run', ok: this.running ? 1 : 0}});
            break;
        case 'progStop':
            this.running = false;
            this._reply({prog: {ack: 'stop', ok: 1}});
            break;
        case 'progErase':
            this.nvs = {program: null, crc: 0, autorun: true};
            this.running = false;
            this._reply({prog: {ack: 'erase', ok: 1}});
            break;
        case 'progInfo':
            this._reply({prog: Object.assign({ack: 'info', ok: 1}, this.status())});
            break;
        default:
            // En modo autónomo el firmware ignora los comandos de hardware:
            // los dos modos nunca actúan a la vez sobre los motores.
            if (this.running) {
                this._reply({prog: {warn: 'busy'}});
            }
            break;
        }
    }

    /**
     * @param {object} cmd Subcomando progBegin.
     */
    _begin (cmd) {
        if (cmd.isa !== this.isa) {
            this._reply({prog: {ack: 'begin', ok: 0, err: 'isa', want: this.isa, got: cmd.isa}});
            return;
        }
        if (cmd.board !== this.boardId) {
            this._reply({prog: {ack: 'begin', ok: 0, err: 'board'}});
            return;
        }
        if (cmd.size > MAX_PERSISTED) {
            this._reply({prog: {ack: 'begin', ok: 0, err: 'size'}});
            return;
        }

        // Subir un programa nuevo reemplaza al anterior y lo detiene.
        this.running = false;
        this._expected = {size: cmd.size, crc: cmd.crc, chunks: cmd.chunks};
        this._buf.fill(0);
        this.chunksSeen = [];
        this._reply({prog: {ack: 'begin', ok: 1}});
    }

    /**
     * @param {object} cmd Subcomando progChunk.
     */
    _chunk (cmd) {
        if (!this._expected) {
            this._reply({prog: {ack: 'chunk', seq: cmd.seq, ok: 0, err: 'nobegin'}});
            return;
        }

        const bytes = fromBase64(cmd.data);
        if (bytes.length > MAX_CHUNK_BYTES) {
            this._reply({prog: {ack: 'chunk', seq: cmd.seq, ok: 0, err: 'toobig'}});
            return;
        }

        // El desplazamiento viene EN EL PROPIO TROZO, no se deduce de `seq`:
        // el firmware no necesita recordar el tamaño de trozo (que además el
        // último no llena). Escritura idempotente en su posición, así que
        // reintentos y desorden salen gratis.
        const offset = cmd.off;
        if (typeof offset !== 'number' || offset + bytes.length > this._expected.size) {
            this._reply({prog: {ack: 'chunk', seq: cmd.seq, ok: 0, err: 'range'}});
            return;
        }
        this._buf.set(bytes, offset);
        this.chunksSeen.push(cmd.seq);

        if (this.dropAcksFor.has(cmd.seq)) {
            // Se "pierde" el ack una sola vez, para probar el reintento.
            this.dropAcksFor.delete(cmd.seq);
            return;
        }
        this._reply({prog: {ack: 'chunk', seq: cmd.seq, ok: 1}});
    }

    /** Verifica el CRC de lo recibido y lo persiste sólo si cuadra. */
    _end () {
        if (!this._expected) {
            this._reply({prog: {ack: 'end', ok: 0, err: 'nobegin'}});
            return;
        }

        const program = this._buf.slice(0, this._expected.size);
        const actual = crc16(program);

        if (actual !== this._expected.crc) {
            this._expected = null;
            this.error = 6; // PC_ERR_CRC
            this._reply({prog: {ack: 'end', ok: 0, err: 'crc', crc: actual}});
            return;
        }

        this.nvs = {program, crc: actual, autorun: true};
        this._expected = null;
        this.error = 0;
        this._reply({prog: {ack: 'end', ok: 1, crc: actual}});
    }

    /**
     * @param {object} payload Objeto a emitir.
     */
    _reply (payload) {
        if (this.onLine) this.onLine(Object.assign({isa: this.isa}, payload));
    }

    /**
     * Estado del programa, tal como va en la telemetría.
     * @returns {object} `{st, sz, crc, err}`.
     */
    status () {
        let st = 'empty';
        if (this.error) st = 'error';
        else if (this.running) st = 'running';
        else if (this.nvs.program) st = 'loaded';

        return {
            st,
            sz: this.nvs.program ? this.nvs.program.length : 0,
            crc: this.nvs.crc,
            err: this.error
        };
    }

    /**
     * Simula apagar y encender la placa: la RAM se pierde, la NVS no, y el
     * programa arranca solo si estaba marcado para ello.
     */
    powerCycle () {
        this._buf = new Uint8Array(PROG_BUF_SIZE);
        this._expected = null;
        this.received = [];
        this.running = !!(this.nvs.program && this.nvs.autorun);
    }

    /**
     * @returns {boolean} True si el programa guardado tiene una cabecera válida.
     */
    storedProgramLooksValid () {
        const p = this.nvs.program;
        if (!p || p.length < HEADER.SIZE + 2) return false;
        const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
        return view.getUint32(HEADER.OFFSETS.magic, true) === HEADER.MAGIC;
    }
}

module.exports = FakeBoard;
module.exports.fromBase64 = fromBase64;
module.exports.MAX_CHUNK_BYTES = MAX_CHUNK_BYTES;
module.exports.MAX_LINE_CHARS = MAX_LINE_CHARS;
module.exports.MAX_PERSISTED = MAX_PERSISTED;
