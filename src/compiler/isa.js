/**
 * ISA (juego de instrucciones) del bytecode de PlayCode.
 *
 * ★ ESTE ARCHIVO ES LA FUENTE ÚNICA DE VERDAD ★
 *
 * De aquí se derivan, y con esto deben coincidir siempre:
 *   - el compilador            (src/compiler/*)
 *   - el intérprete de referencia en JS (src/compiler/reference-vm/vm.js)
 *   - el intérprete del firmware en C++ (vía src/compiler/generated/playcode_isa.h,
 *     generado por tools/gen-isa-header.js -- NO se edita a mano)
 *
 * REGLA: hay que subir ISA_VERSION ante CUALQUIER cambio en OPCODES, OPERANDS,
 * los ids/argc de las primitivas de hardware, o el layout de la cabecera.
 * Añadir una primitiva nueva al final TAMBIÉN cuenta: un firmware viejo debe
 * rechazar limpiamente un programa que la use, en vez de ejecutar basura.
 *
 * La máquina es de PILA: los operandos se empujan y cada instrucción los
 * consume. Los saltos son relativos al PC de la instrucción SIGUIENTE.
 */

/**
 * Versión del juego de instrucciones. La placa la reporta en su telemetría
 * (`"isa":N`) y el compilador la escribe en la cabecera de cada programa; si no
 * coinciden, la subida se rechaza con un mensaje entendible en vez de correr
 * bytecode que el firmware interpretaría mal.
 * @type {number}
 */
const ISA_VERSION = 1;

/**
 * Identificadores de placa. Van en la cabecera para que una placa rechace un
 * programa compilado para otra (los ids de hardware NO son compatibles entre
 * placas: el 0x01 de PlayGo no es el 0x01 de PlayBoard).
 * @enum {number}
 */
const BOARD_IDS = {
    playgo: 1,
    playiot: 2,
    playme: 3,
    playboard: 4
};

/**
 * Opcodes. Agrupados por rango para que el volcado hexadecimal sea legible a
 * simple vista al depurar: 0x0x pila, 0x1x variables, 0x2x aritmética,
 * 0x3x lógica, 0x4x strings, 0x5x saltos, 0x6x tiempo, 0x7x hardware.
 * @enum {number}
 */
const OPCODES = {
    // -- Pila y constantes --
    NOP: 0x00,
    PUSH_F32: 0x01,
    PUSH_I8: 0x02, // vía rápida: 0, 1, 50, 100... son la mayoría de literales
    PUSH_STR: 0x03,
    PUSH_TRUE: 0x04,
    PUSH_FALSE: 0x05,
    POP: 0x06,
    DUP: 0x07,

    // -- Variables (en v1 todas globales a la placa: no hay sprites) --
    LOAD_VAR: 0x10,
    STORE_VAR: 0x11,
    CHANGE_VAR: 0x12, // data_changevariableby en una sola instrucción

    // -- Aritmética --
    ADD: 0x20,
    SUB: 0x21,
    MUL: 0x22,
    DIV: 0x23,
    MOD: 0x24,
    RANDOM: 0x25,
    ROUND: 0x26,
    MATHOP: 0x27,

    // -- Comparación y lógica --
    LT: 0x30,
    EQ: 0x31,
    GT: 0x32,
    AND: 0x33,
    OR: 0x34,
    NOT: 0x35,

    // -- Strings --
    JOIN: 0x40,
    LETTER_OF: 0x41,
    LENGTH: 0x42,
    CONTAINS: 0x43,

    // -- Control de flujo --
    JMP: 0x50,
    JZ: 0x51, // salta si el tope es falsy
    JNZ: 0x52, // salta si el tope es truthy
    REPEAT_SETUP: 0x53, // pop N -> empuja max(0, round(N)) a la pila de bucles
    LOOP_TEST: 0x54, // si el contador llegó a 0: lo saca y salta al final
    LOOP_NEXT: 0x55, // decrementa el contador y salta al inicio del cuerpo

    // -- Tiempo y planificación --
    YIELD: 0x60,
    WAIT: 0x61, // pop segundos
    STOP: 0x63, // u8 modo (ver STOP_MODES)
    HALT: 0x64,
    TIMER: 0x66,
    TIMER_RESET: 0x67,

    // -- Hardware --
    CALL_HW: 0x70, // no devuelve valor (bloques COMMAND)
    CALL_HW_R: 0x71, // devuelve 1 valor  (bloques REPORTER / BOOLEAN)
    CALL_HW_WAIT: 0x72, // arranca una operación larga y duerme el hilo hasta que acabe

    TRAP: 0x7F // aborta el programa con un código de error (u8)
};

/**
 * Tipos de operando y su tamaño en bytes. Todos little-endian.
 * @enum {number}
 */
const OPERAND_SIZES = {
    u8: 1,
    i8: 1,
    u16: 2,
    i16: 2,
    f32: 4
};

/**
 * Operandos inmediatos de cada opcode (los que NO tiene aquí van sin operandos
 * y ocupan 1 byte). Es lo que permite recorrer el código sin ambigüedad.
 * @type {Object.<string, Array.<string>>}
 */
const OPERANDS = {
    PUSH_F32: ['f32'],
    PUSH_I8: ['i8'],
    PUSH_STR: ['u16'],

    LOAD_VAR: ['u8'],
    STORE_VAR: ['u8'],
    CHANGE_VAR: ['u8'],

    MATHOP: ['u8'],

    JMP: ['i16'],
    JZ: ['i16'],
    JNZ: ['i16'],
    LOOP_TEST: ['i16'],
    LOOP_NEXT: ['i16'],

    STOP: ['u8'],

    // hwId + argc. El argc es REDUNDANTE a propósito: el intérprete verifica
    // que coincida con la aridad declarada de la primitiva y aborta con
    // ERR_ARITY si no. Es la red barata contra una desincronización de tablas
    // entre JS y C++ -- falla limpio en vez de corromper la pila y mover
    // motores al azar.
    CALL_HW: ['u8', 'u8'],
    CALL_HW_R: ['u8', 'u8'],
    CALL_HW_WAIT: ['u8', 'u8'],

    TRAP: ['u8']
};

/**
 * Funciones de `operator_mathop`, en el orden en que las numera el bytecode.
 * @type {Array.<string>}
 */
const MATHOP_FUNCTIONS = [
    'abs', 'floor', 'ceiling', 'sqrt', 'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'ln', 'log', 'e ^', '10 ^'
];

/**
 * Modos de `control_stop`.
 * @enum {number}
 */
const STOP_MODES = {
    'all': 0, // todos los hilos + apagado seguro del hardware
    'this script': 1,
    'other scripts in sprite': 2
};

/**
 * Tipos de sombrero (bloque de inicio) de cada hilo. En v1 solo existe la
 * bandera verde, pero el byte va en el formato desde el día 1: añadirlo
 * después obligaría a subir la versión de ISA y reflashear placas ya
 * repartidas en colegios.
 * @enum {number}
 */
const HAT_KINDS = {
    whenFlagClicked: 0
    // 1..255 reservados (p. ej. al recibir mensaje, al presionar botón)
};

/**
 * Códigos de error de ejecución que la placa reporta en su telemetría
 * (`{"prog":{"err":N}}`).
 * @enum {number}
 */
const RUNTIME_ERRORS = {
    NONE: 0,
    STACK_OVERFLOW: 1,
    BAD_OPCODE: 2,
    BAD_HW_ID: 3,
    ARITY: 4,
    DOMAIN: 5,
    CRC: 6,
    RUNAWAY: 7
};

/**
 * Layout de la cabecera del binario (16 bytes, little-endian).
 * @type {Object}
 */
const HEADER = {
    /** 'PCBC' little-endian, como u32. */
    MAGIC: 0x43424350,
    SIZE: 16,
    OFFSETS: {
        magic: 0, // u32
        isaVersion: 4, // u8
        boardId: 5, // u8
        flags: 6, // u16
        numVars: 8, // u16
        numThreads: 10, // u8
        numStrings: 11, // u8
        codeSize: 12, // u16
        headerCrc: 14 // u16 -- CRC16 de los bytes 0..13 (rechazo temprano barato)
    }
};

/**
 * Banderas de la cabecera.
 * @enum {number}
 */
const HEADER_FLAGS = {
    /** Arrancar el programa solo al encender la placa. */
    AUTORUN: 0x0001
};

/** Bytes de cada entrada de la tabla de hilos: u8 hatKind + u16 entryPc. */
const THREAD_ENTRY_SIZE = 3;

/**
 * Mapa inverso byte -> nombre de opcode. Lo usan el desensamblador, los
 * mensajes de error y el intérprete de referencia.
 * @type {Object.<number, string>}
 */
const OPCODE_NAMES = Object.keys(OPCODES).reduce((acc, name) => {
    acc[OPCODES[name]] = name;
    return acc;
}, {});

/**
 * Tamaño total en bytes de una instrucción (opcode + operandos inmediatos).
 * @param {string} name Nombre del opcode.
 * @returns {number} Bytes que ocupa.
 */
const instructionSize = function (name) {
    const operands = OPERANDS[name] || [];
    return 1 + operands.reduce((sum, kind) => sum + OPERAND_SIZES[kind], 0);
};

module.exports = {
    ISA_VERSION,
    BOARD_IDS,
    OPCODES,
    OPCODE_NAMES,
    OPERANDS,
    OPERAND_SIZES,
    MATHOP_FUNCTIONS,
    STOP_MODES,
    HAT_KINDS,
    RUNTIME_ERRORS,
    HEADER,
    HEADER_FLAGS,
    THREAD_ENTRY_SIZE,
    instructionSize
};
