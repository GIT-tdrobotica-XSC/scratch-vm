/**
 * CRC16-CCITT (polinomio 0x1021, valor inicial 0xFFFF, sin reflejar).
 *
 * Se usa en dos sitios: la cabecera del binario (para rechazar basura antes de
 * leer nada más) y el binario completo (para que la placa verifique que la
 * subida por chunks llegó íntegra antes de persistirla).
 *
 * Elegido por ser trivial de implementar en C++ sin dependencias ni tablas
 * grandes: la versión del firmware debe dar EXACTAMENTE el mismo resultado que
 * ésta, así que se mantiene deliberadamente simple (bit a bit, sin tabla).
 */

const POLYNOMIAL = 0x1021;
const INITIAL = 0xFFFF;

/**
 * Calcula el CRC16-CCITT de un bloque de bytes.
 * @param {Uint8Array|Array.<number>} bytes Datos de entrada.
 * @param {number} [start] Índice inicial (inclusive), 0 por defecto.
 * @param {number} [end] Índice final (exclusivo), el largo por defecto.
 * @returns {number} CRC de 16 bits.
 */
const crc16 = function (bytes, start, end) {
    const from = typeof start === 'number' ? start : 0;
    const to = typeof end === 'number' ? end : bytes.length;

    let crc = INITIAL;
    for (let i = from; i < to; i++) {
        crc ^= (bytes[i] & 0xFF) << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000) ?
                ((crc << 1) ^ POLYNOMIAL) :
                (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
};

module.exports = crc16;
