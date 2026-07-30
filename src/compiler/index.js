/**
 * Entrada pública del compilador de bloques a bytecode.
 *
 * Vive en la VM y no en la GUI a propósito: así se puede probar entero en Node
 * sin navegador, y la GUI queda tonta (compila, muestra el progreso, muestra
 * los errores).
 */

const Compiler = require('./compile-blocks');
const {serializeProgram} = require('./serialize');
const {limitsForBoard} = require('./constants');
const {CompileError, CompileErrorGroup, ErrorCode} = require('./errors');

/**
 * Descriptores de placa disponibles. Añadir PlayIoT/PlayMe es añadir su
 * `hw-map.js` + `blocks-map.js` y una línea aquí.
 * @type {Object.<string, function(): object>}
 */
const TARGETS = {
    playgo: () => {
        const hwMap = require('./targets/playgo/hw-map');
        const blocksMap = require('./targets/playgo/blocks-map');
        return Object.assign({}, hwMap, {BLOCKS: blocksMap.BLOCKS});
    }
};

/**
 * @param {string} boardName Id de extensión de la placa.
 * @returns {object} Descriptor de la placa.
 */
const targetForBoard = function (boardName) {
    const factory = TARGETS[boardName];
    if (!factory) {
        throw new CompileError(
            ErrorCode.UNSUPPORTED_BLOCK,
            `Todavía no se puede subir un programa a "${boardName}".`
        );
    }
    return factory();
};

/**
 * @typedef {object} CompileResult
 * @property {Uint8Array} bytes Binario listo para subir.
 * @property {Array.<object>} warnings Avisos (no impiden subir).
 * @property {object} stats Tamaños y conteos, para mostrar en la GUI.
 */

/**
 * Compila los bloques de un target de dispositivo.
 *
 * @param {object} blocks Contenedor `Blocks` (normalmente `target.blocks`).
 * @param {string} boardName Id de extensión de la placa ('playgo'...).
 * @param {object} [options] Opciones.
 * @param {boolean} [options.autorun] Arrancar solo al encender (por defecto sí).
 * @returns {CompileResult} El programa compilado.
 * @throws {CompileErrorGroup} Con TODOS los errores encontrados en `.errors`,
 *     no sólo el primero: un niño con tres bloques mal debe verlos los tres de
 *     una vez, no arreglar uno y descubrir el siguiente.
 */
const compileBlocks = function (blocks, boardName, options) {
    const opts = options || {};
    const target = targetForBoard(boardName);
    const limits = limitsForBoard(boardName);

    const compiler = new Compiler(blocks, target, limits);
    const result = compiler.compile();

    if (compiler.errors.length > 0) throw new CompileErrorGroup(compiler.errors);

    const bytes = serializeProgram({
        boardId: target.boardId,
        strings: result.strings,
        threads: result.threads,
        code: result.code,
        numVars: result.numVars,
        autorun: opts.autorun !== false
    });

    if (bytes.length > limits.maxProgramSize) {
        throw new CompileErrorGroup([new CompileError(
            ErrorCode.PROGRAM_TOO_BIG,
            `Tu programa ocupa ${bytes.length} bytes y en el robot sólo caben ` +
            `${limits.maxProgramSize}.`,
            {hint: 'Prueba usando "repetir" en vez de copiar los mismos bloques varias veces.'}
        )]);
    }

    return {
        bytes,
        warnings: compiler.warnings,
        stats: {
            codeSize: result.code.length,
            programSize: bytes.length,
            threads: result.threads.length,
            variables: result.numVars,
            strings: result.strings.length,
            maxStack: result.maxStack,
            maxLoopDepth: result.maxLoopDepth,
            limits
        }
    };
};

module.exports = {
    compileBlocks,
    targetForBoard,
    TARGETS
};
