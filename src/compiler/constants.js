/**
 * Límites del compilador, por placa.
 *
 * Están declarados por placa desde el día 1 (aunque hoy todas las ESP32 usen
 * los mismos valores) porque PlayBoard / Arduino UNO tiene 2 KB de SRAM y
 * ~7 KB de flash libres: cuando llegue su turno, lo único que cambia es esta
 * tabla, no el compilador. Los límites del intérprete (pila, bucles) deben
 * coincidir EXACTAMENTE con los del firmware; si el firmware baja una pila,
 * hay que bajarla aquí también o el programa desbordará en la placa.
 */

/**
 * @typedef {object} BoardLimits
 * @property {number} maxCodeSize Bytes de código máquina.
 * @property {number} maxProgramSize Bytes del binario completo (lo que se
 *     persiste en la placa).
 * @property {number} maxThreads Sombreros ("banderas verdes") simultáneos.
 * @property {number} maxVars Variables distintas.
 * @property {number} maxStrings Entradas de la tabla de strings.
 * @property {number} maxStringTableBytes Peso total de los textos.
 * @property {number} maxStackDepth Profundidad de la pila de valores. El
 *     compilador la verifica ESTÁTICAMENTE: así un desbordamiento sale como
 *     mensaje en pantalla y no como un robot congelado que nadie sabe
 *     diagnosticar.
 * @property {number} maxLoopDepth Profundidad de la pila de bucles.
 */

/**
 * Perfil de las placas ESP32 (PlayGo / PlayIoT / PlayMe): memoria de sobra, así
 * que el límite real lo pone la persistencia en NVS, no la RAM.
 * @type {BoardLimits}
 */
const ESP32_LIMITS = {
    // 4 KB es el punto a partir del cual un blob de NVS empieza a sufrir
    // fragmentación de páginas. Son ~2000 instrucciones: muy por encima de
    // cualquier programa de bloques infantil.
    maxProgramSize: 4096,
    maxCodeSize: 3584,
    maxThreads: 8,
    maxVars: 64,
    maxStrings: 64,
    maxStringTableBytes: 512,
    maxStackDepth: 16,
    maxLoopDepth: 8
};

/**
 * Límites por placa.
 * @type {Object.<string, BoardLimits>}
 */
const BOARD_LIMITS = {
    playgo: ESP32_LIMITS,
    playiot: ESP32_LIMITS,
    playme: ESP32_LIMITS
    // playboard (ATmega328p) llegará con límites mucho más apretados:
    // ~1 KB de programa en EEPROM, 2 hilos, pilas de 8, sin tabla de strings.
};

/**
 * Devuelve los límites de una placa.
 * @param {string} boardName Id de extensión ('playgo', 'playiot'...).
 * @returns {BoardLimits} Límites de esa placa.
 */
const limitsForBoard = function (boardName) {
    const limits = BOARD_LIMITS[boardName];
    if (!limits) {
        throw new Error(`No hay límites de compilación definidos para la placa "${boardName}"`);
    }
    return limits;
};

module.exports = {
    ESP32_LIMITS,
    BOARD_LIMITS,
    limitsForBoard
};
