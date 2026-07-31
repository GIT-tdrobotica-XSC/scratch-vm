/**
 * Subida de un programa compilado a la placa, sobre el protocolo JSON que ya
 * existe.
 *
 * Compartido por las cuatro placas desde el día 1: el protocolo es idéntico en
 * PlayGo, PlayIoT, PlayMe y PlayBoard, y no cuesta nada hacerlo bien de
 * entrada.
 *
 * ── DECISIONES QUE IMPORTAN ─────────────────────────────────────────────────
 *
 * **Se espera el ack de cada trozo, no se hace streaming.** El firmware drena
 * `Serial.available()` una vez por vuelta de `loop()`, y esa vuelta puede
 * tardar 100 ms cuando el OLED vuelca: una ráfaga desbordaría la FIFO de 256
 * bytes y se perderían trozos EN SILENCIO. Con ack por trozo, 3 KB tardan
 * ~400 ms por USB, que es perfectamente aceptable para lo que se gana.
 *
 * **Los trozos son idempotentes.** El firmware escribe en
 * `progBuf[seq * CHUNK]`, así que reintentar uno o recibirlos desordenados
 * sale gratis.
 *
 * **El tamaño de trozo depende del transporte.** Por BLE la GUI trocea cada
 * escritura en paquetes de 20 bytes, así que una línea larga son ~30
 * escrituras GATT seguidas: exactamente el patrón de congestión detrás de toda
 * la saga de desconexiones documentada en PROTOCOLO.md. Por eso BLE usa trozos
 * mucho más pequeños y se recomienda USB para subir.
 *
 * **Base64 y no binario crudo** porque el transporte pasa por
 * `TextEncoderStream` y el troceado del protocolo es por saltos de línea: unos
 * bytes arbitrarios romperían las dos cosas.
 */

const crc16 = require('../../compiler/crc16');
const {ISA_VERSION} = require('../../compiler/isa');

/** Bytes de programa por trozo, según el transporte. */
const CHUNK_SIZE = {
    usb: 384,
    ble: 128
};

/** Cuánto se espera un ack antes de reintentar. */
const ACK_TIMEOUT_MS = 2000;

/** Reintentos del mismo trozo antes de rendirse. */
const MAX_RETRIES = 3;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Codifica bytes a base64.
 *
 * Se implementa a mano en vez de usar `btoa`/`Buffer` porque este código corre
 * tanto en el navegador como en Node (los tests), y ninguno de los dos
 * globales existe en ambos sitios de forma fiable.
 *
 * @param {Uint8Array} bytes Datos.
 * @returns {string} Texto en base64.
 */
const toBase64 = function (bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const hasB1 = i + 1 < bytes.length;
        const hasB2 = i + 2 < bytes.length;

        out += B64_ALPHABET[b0 >> 2];
        out += B64_ALPHABET[((b0 & 0x03) << 4) | (hasB1 ? (b1 >> 4) : 0)];
        out += hasB1 ? B64_ALPHABET[((b1 & 0x0F) << 2) | (hasB2 ? (b2 >> 6) : 0)] : '=';
        out += hasB2 ? B64_ALPHABET[b2 & 0x3F] : '=';
    }
    return out;
};

/**
 * Estados que puede reportar la placa sobre el programa que tiene guardado.
 * @enum {string}
 */
const ProgramState = {
    EMPTY: 'empty',
    LOADED: 'loaded',
    RUNNING: 'running',
    ERROR: 'error'
};

/**
 * Error de subida, con la causa en un campo aparte para que la GUI pueda dar
 * un mensaje distinto según qué falló.
 */
class UploadError extends Error {
    /**
     * @param {string} reason Causa ('isa', 'size', 'board', 'crc', 'timeout',
     *     'disconnected').
     * @param {string} message Mensaje en español para el usuario.
     */
    constructor (reason, message) {
        super(message);
        this.name = 'UploadError';
        this.reason = reason;
    }
}

/** Mensajes de usuario para cada causa de rechazo de la placa. */
const REASON_MESSAGES = {
    isa: 'Tu robot necesita actualizar su firmware para poder correr este programa.',
    board: 'Este programa fue hecho para otro tipo de placa.',
    size: 'El programa es demasiado grande para la memoria del robot.',
    crc: 'El programa llegó dañado al robot. Vuelve a intentarlo.',
    toobig: 'Un trozo del programa era demasiado grande. Vuelve a intentarlo.',
    timeout: 'El robot no respondió. Revisa el cable y vuelve a intentarlo.',
    disconnected: 'Se perdió la conexión con el robot.'
};

class ProgramUploader {
    /**
     * @param {object} io Transporte: `{send(line), isConnected()}`.
     * @param {object} [options] Opciones.
     * @param {string} [options.transport] 'usb' o 'ble' (elige el tamaño de trozo).
     * @param {number} [options.boardId] Id de placa esperado.
     */
    constructor (io, options) {
        const opts = options || {};
        this._io = io;
        this._transport = opts.transport === 'ble' ? 'ble' : 'usb';
        this._boardId = opts.boardId;

        /** Acks pendientes: tipo -> `{resolve, reject, timer}`. */
        this._pending = new Map();

        /** Último estado reportado por la placa. */
        this.programStatus = null;
        /** Versión de ISA que dice tener la placa. */
        this.deviceIsa = null;
    }

    /**
     * El peripheral llama a esto con cada línea de telemetría recibida.
     * @param {object} data Objeto JSON recibido de la placa.
     */
    handleTelemetry (data) {
        if (typeof data.isa === 'number') this.deviceIsa = data.isa;
        if (!data.prog) return;

        const prog = data.prog;
        if (prog.st) this.programStatus = prog;

        if (prog.ack) {
            const key = typeof prog.seq === 'number' ? `${prog.ack}:${prog.seq}` : prog.ack;
            this._resolveAck(key, prog);
            // Un ack de trozo también resuelve una espera genérica de "chunk",
            // por si llegó desordenado.
            if (prog.ack === 'chunk') this._resolveAck('chunk', prog);
        }
    }

    /**
     * @param {string} key Clave del ack.
     * @param {object} payload Contenido.
     */
    _resolveAck (key, payload) {
        const waiter = this._pending.get(key);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this._pending.delete(key);
        waiter.resolve(payload);
    }

    /**
     * Envía un subcomando y espera su ack.
     *
     * @param {object} fields Campos del subcomando (incluye `command`).
     * @param {string} ackKey Clave del ack esperado.
     * @param {number} [timeoutMs] Tiempo máximo de espera.
     * @returns {Promise.<object>} El contenido del ack.
     */
    _request (fields, ackKey, timeoutMs) {
        if (!this._io.isConnected()) {
            return Promise.reject(new UploadError('disconnected', REASON_MESSAGES.disconnected));
        }

        const line = JSON.stringify({command: 'outputsQueue', testValue: [fields]});

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(ackKey);
                reject(new UploadError('timeout', REASON_MESSAGES.timeout));
            }, timeoutMs || ACK_TIMEOUT_MS);

            this._pending.set(ackKey, {resolve, reject, timer});

            Promise.resolve(this._io.send(line)).catch(err => {
                clearTimeout(timer);
                this._pending.delete(ackKey);
                reject(err);
            });
        });
    }

    /**
     * Comprueba un ack y lanza un error con mensaje de usuario si la placa
     * rechazó la operación.
     * @param {object} ack Contenido del ack.
     */
    _assertOk (ack) {
        if (ack.ok === 1 || ack.ok === true) return;
        const reason = ack.err || 'crc';
        throw new UploadError(reason, REASON_MESSAGES[reason] ||
            'El robot rechazó el programa.');
    }

    /**
     * Sube un programa compilado a la placa y lo deja corriendo.
     *
     * @param {Uint8Array} bytes Binario producido por el compilador.
     * @param {object} [options] Opciones.
     * @param {Function} [options.onProgress] `(fraction, phase)` con fraction
     *     entre 0 y 1.
     * @param {boolean} [options.run] Arrancar el programa al terminar (sí por
     *     defecto).
     * @returns {Promise.<object>} Estadísticas de la subida.
     */
    async upload (bytes, options) {
        const opts = options || {};
        const report = opts.onProgress || (() => {});

        const chunkSize = CHUNK_SIZE[this._transport];
        const totalChunks = Math.ceil(bytes.length / chunkSize);
        const checksum = crc16(bytes);

        report(0, 'begin');

        const begin = await this._request({
            command: 'progBegin',
            size: bytes.length,
            crc: checksum,
            isa: ISA_VERSION,
            board: this._boardId,
            chunks: totalChunks
        }, 'begin');
        this._assertOk(begin);

        for (let seq = 0; seq < totalChunks; seq++) {
            const offset = seq * chunkSize;
            const slice = bytes.subarray(offset, offset + chunkSize);
            await this._sendChunkWithRetries(seq, offset, slice);
            report(((seq + 1) / totalChunks) * 0.9, 'chunk');
        }

        report(0.95, 'end');
        const end = await this._request({command: 'progEnd'}, 'end', 4000);
        this._assertOk(end);

        // La placa recalcula el CRC sobre lo que realmente recibió. Si no
        // coincide con el nuestro, algo se perdió pese a los acks y es mejor
        // saberlo aquí que descubrirlo con el robot haciendo cosas raras.
        if (typeof end.crc === 'number' && end.crc !== checksum) {
            throw new UploadError('crc', REASON_MESSAGES.crc);
        }

        if (opts.run !== false) {
            await this._request({command: 'progRun'}, 'run');
        }

        report(1, 'done');
        return {size: bytes.length, chunks: totalChunks, crc: checksum};
    }

    /**
     * Envía un trozo, reintentándolo si no llega su ack.
     *
     * Cada trozo lleva su propio desplazamiento (`off`) en vez de dejar que el
     * firmware lo deduzca de `seq`. Deducirlo exigiría que ambos lados
     * coincidieran en el tamaño de trozo, y el último trozo casi nunca lo
     * llena: con el desplazamiento explícito el firmware queda SIN ESTADO y
     * escribir donde toca es correcto por construcción, aunque los trozos
     * lleguen desordenados o repetidos.
     *
     * @param {number} seq Número de trozo (sólo para el ack y el progreso).
     * @param {number} offset Posición en el programa donde va este trozo.
     * @param {Uint8Array} slice Bytes del trozo.
     */
    async _sendChunkWithRetries (seq, offset, slice) {
        const data = toBase64(slice);
        let lastError = null;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const ack = await this._request(
                    {command: 'progChunk', seq, off: offset, data},
                    `chunk:${seq}`
                );
                this._assertOk(ack);
                return;
            } catch (err) {
                lastError = err;
                // Un rechazo explícito de la placa no se arregla reintentando.
                if (err instanceof UploadError && err.reason !== 'timeout') throw err;
                if (!this._io.isConnected()) {
                    throw new UploadError('disconnected', REASON_MESSAGES.disconnected);
                }
            }
        }
        throw lastError;
    }

    /**
     * Arranca el programa guardado.
     * @returns {Promise.<object>} Ack.
     */
    run () {
        return this._request({command: 'progRun'}, 'run');
    }

    /**
     * Detiene el programa y deja el hardware en un estado seguro.
     * @returns {Promise.<object>} Ack.
     */
    stop () {
        return this._request({command: 'progStop'}, 'stop');
    }

    /**
     * Borra el programa guardado en la placa.
     * @returns {Promise.<object>} Ack.
     */
    erase () {
        return this._request({command: 'progErase'}, 'erase');
    }

    /**
     * Pregunta qué programa tiene guardado la placa.
     * @returns {Promise.<object>} Estado del programa.
     */
    async info () {
        const ack = await this._request({command: 'progInfo'}, 'info');
        this.programStatus = ack;
        return ack;
    }

    /** Cancela todas las esperas pendientes (al desconectar). */
    cancelPending () {
        for (const waiter of this._pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new UploadError('disconnected', REASON_MESSAGES.disconnected));
        }
        this._pending.clear();
    }
}

module.exports = ProgramUploader;
module.exports.toBase64 = toBase64;
module.exports.CHUNK_SIZE = CHUNK_SIZE;
module.exports.ProgramState = ProgramState;
module.exports.UploadError = UploadError;
module.exports.REASON_MESSAGES = REASON_MESSAGES;
