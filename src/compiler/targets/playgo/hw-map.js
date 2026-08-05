/**
 * Mapa de primitivas de hardware de PlayGo (ESP32-S3).
 *
 * Cada entrada corresponde a una función C++ del firmware. Los nombres son
 * DELIBERADAMENTE los mismos que los `case` de `processSubcommand()`
 * (PlayGo/src/main.cpp:703): eso permite que el test de divergencia compare
 * directamente la secuencia de subcomandos JSON que produce el modo directo
 * contra el registro de llamadas del intérprete de referencia, sin tabla de
 * traducción de por medio.
 *
 * `argc` debe coincidir EXACTAMENTE con lo que espera el firmware: se emite al
 * header C++ como `PC_HW_ARGC[]` y el intérprete lo verifica en cada
 * `CALL_HW`, abortando con ERR_ARITY si no cuadra.
 *
 * `kind`:
 *   'cmd'      -> CALL_HW       (no devuelve valor)
 *   'reporter' -> CALL_HW_R     (devuelve 1 valor)
 *   'wait'     -> CALL_HW_WAIT  (arranca algo largo y duerme el hilo)
 *
 * `needsFirmware: true` marca las primitivas que TODAVÍA NO EXISTEN en el
 * firmware y hay que añadir en F3/F5. Son de dos tipos:
 *   - los reporters de sensores, cuya lectura hoy está enterrada dentro de
 *     `sendTelemetry()` (main.cpp:630-649) y hay que extraer a funciones para
 *     que telemetría e intérprete llamen a lo mismo;
 *   - `toneStopIf`, ~5 líneas, sin la cual `releaseNote` no puede distinguir
 *     "suelta esta nota" de "silencia todo" y se rompe el patrón de piano.
 */

const {BOARD_IDS} = require('../../isa');

/**
 * Codificaciones numéricas de argumentos que en el protocolo JSON son strings.
 * El bytecode no manda texto donde alcanza un byte.
 * @enum {number}
 */
const WHEEL = {
    both: 0,
    left: 1,
    right: 2
};

/** @enum {number} */
const IO_MODE = {
    'playBlocks': 0,
    'play+': 1
};

/** Valor de `led` que el firmware interpreta como "todos los LEDs". */
const RGB_ALL = -1;

/**
 * Tabla de primitivas. Los ids se agrupan por familia para que un volcado
 * hexadecimal sea legible: 0x0x movimiento, 0x1x IO, 0x2x RGB, 0x3x OLED,
 * 0x4x audio, 0x5x sensores.
 *
 * ⚠️ Los ids NO se reordenan ni se reutilizan nunca. Si una primitiva se
 * retira, su id queda quemado. Cualquier cambio aquí obliga a subir
 * ISA_VERSION.
 */
const HW = {
    // -- Movimiento --
    setMotorSpeed: {id: 0x01, argc: 2, kind: 'cmd', args: ['left', 'right']},
    stopMotors: {id: 0x02, argc: 0, kind: 'cmd', args: []},
    moveDistance: {
        id: 0x03,
        argc: 4,
        kind: 'wait',
        args: ['distanceCm', 'speed', 'wheelDiameterCm', 'pulsesPerRev']
    },
    turnAngle: {
        id: 0x04,
        argc: 5,
        kind: 'wait',
        args: ['angleDeg', 'speed', 'wheelDiameterCm', 'trackWidthCm', 'pulsesPerRev']
    },
    turnWheelRevs: {
        id: 0x05,
        argc: 4,
        kind: 'wait',
        args: ['wheel', 'revolutions', 'speed', 'pulsesPerRev']
    },
    resetEncoders: {id: 0x06, argc: 0, kind: 'cmd', args: []},

    // -- Entrada/salida digital y servos --
    servoWrite: {id: 0x10, argc: 2, kind: 'cmd', args: ['pin', 'angle']},
    digitalWrite: {id: 0x11, argc: 2, kind: 'cmd', args: ['gpio', 'value']},
    setIOMode: {id: 0x12, argc: 1, kind: 'cmd', args: ['mode']},

    // -- LEDs RGB --
    setRGB: {id: 0x20, argc: 4, kind: 'cmd', args: ['led', 'r', 'g', 'b']},

    // -- Pantalla OLED --
    oledText: {id: 0x30, argc: 2, kind: 'cmd', args: ['text', 'size']},
    oledNumber: {id: 0x31, argc: 3, kind: 'cmd', args: ['line', 'label', 'value']},
    oledClear: {id: 0x32, argc: 0, kind: 'cmd', args: []},
    oledLine: {id: 0x33, argc: 2, kind: 'cmd', args: ['line', 'text']},
    oledTextXY: {id: 0x34, argc: 4, kind: 'cmd', args: ['text', 'x', 'y', 'size']},
    oledEmoji: {id: 0x35, argc: 3, kind: 'cmd', args: ['emoji', 'x', 'y']},
    oledDrawLine: {id: 0x36, argc: 4, kind: 'cmd', args: ['x0', 'y0', 'x1', 'y1']},
    oledDrawRect: {id: 0x37, argc: 4, kind: 'cmd', args: ['x', 'y', 'w', 'h']},
    oledFillRect: {id: 0x38, argc: 4, kind: 'cmd', args: ['x', 'y', 'w', 'h']},
    oledDrawCircle: {id: 0x39, argc: 3, kind: 'cmd', args: ['x', 'y', 'r']},
    oledDrawPixel: {id: 0x3A, argc: 2, kind: 'cmd', args: ['x', 'y']},
    oledDisplay: {id: 0x3B, argc: 0, kind: 'cmd', args: []},

    // -- Audio --
    tone: {id: 0x40, argc: 2, kind: 'cmd', args: ['freq', 'durationMs']},
    toneStop: {id: 0x41, argc: 0, kind: 'cmd', args: []},
    // Silencia sólo si suena ESTA frecuencia. Sin ella, "soltar nota" apagaría
    // cualquier nota, y dos teclas de piano solapadas se pisarían.
    toneStopIf: {id: 0x42, argc: 1, kind: 'cmd', args: ['freq'], needsFirmware: true},

    // -- Sensores (reporters) --
    // Hoy estas lecturas viven inline dentro de sendTelemetry(); hay que
    // extraerlas a funciones para que telemetría e intérprete compartan
    // exactamente el mismo código (si divergen, el robot autónomo "vería" algo
    // distinto de lo que PlayCode muestra en pantalla).
    readButton: {id: 0x50, argc: 1, kind: 'reporter', args: ['index'], needsFirmware: true},
    readGpio: {id: 0x51, argc: 1, kind: 'reporter', args: ['n'], needsFirmware: true},
    readAnalog: {id: 0x52, argc: 1, kind: 'reporter', args: ['n'], needsFirmware: true},
    readEncoder: {id: 0x53, argc: 1, kind: 'reporter', args: ['side'], needsFirmware: true},
    micLevel: {id: 0x54, argc: 0, kind: 'reporter', args: [], needsFirmware: true},

    /**
     * Botón de un control remoto (el modal de PlayCode, o un mando dedicado).
     *
     * Es un SENSOR, no una orden: el control no manda al robot, solo actualiza
     * un estado que el programa del niño consulta cuando quiere. Por eso puede
     * convivir con el modo autónomo sin romper la regla de "un solo dueño del
     * hardware" -- el programa de la placa sigue mandando, y el control es una
     * entrada más, como los botones soldados.
     *
     * Si el control deja de dar señal (se cierra la pestaña, se sale de
     * alcance), el firmware apaga todos sus botones solo. Esa es la diferencia
     * con leer el teclado del PC: aquí "no hay noticias" es un estado que la
     * placa puede detectar, y ante la duda contesta "no presionado" en vez de
     * quedarse pegada con la última tecla.
     */
    readRemote: {id: 0x55, argc: 1, kind: 'reporter', args: ['button'], needsFirmware: true}
};

/** Mapa inverso id -> nombre, para desensamblar y para los mensajes de error. */
const HW_NAMES = Object.keys(HW).reduce((acc, name) => {
    acc[HW[name].id] = name;
    return acc;
}, {});

module.exports = {
    boardName: 'playgo',
    boardId: BOARD_IDS.playgo,
    HW,
    HW_NAMES,
    WHEEL,
    IO_MODE,
    RGB_ALL
};
