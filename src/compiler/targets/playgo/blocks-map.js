/**
 * Descriptor de los 37 bloques de PlayGo: cómo se traduce cada uno a
 * primitivas de hardware.
 *
 * ── LA REGLA QUE ORGANIZA TODO ──────────────────────────────────────────────
 *
 *   Lo que el handler de `playgo/blocks.js` calcula A PARTIR DE CONSTANTES
 *     -> el compilador lo PLIEGA aquí, en tiempo de compilación.
 *   Lo que calcula A PARTIR DE VALORES EN EJECUCIÓN
 *     -> se emite como aritmética de bytecode (`post`).
 *   Sólo lo que ya es un `case` de `processSubcommand()` en el firmware
 *     -> se convierte en primitiva de hardware.
 *
 * Gracias a eso la tabla de hardware del firmware queda mínima y es casi un
 * espejo del despachador que ya existe: `setRGBPreset`, `setRGBColorHex`,
 * `setServoPlayGo` y `playNote` no necesitan NADA nuevo en el firmware, porque
 * sus tablas (colores, puertos, frecuencias de notas) se resuelven aquí.
 *
 * ── DÓNDE VIVE CADA ARGUMENTO ───────────────────────────────────────────────
 *
 * Depende de `acceptReporters` del menú (ver runtime.js:1465-1488):
 *   acceptReporters: false -> FIELD sobre el bloque, con el nombre del
 *                             argumento (`{field: 'PORT'}`).
 *   acceptReporters: true  -> INPUT, con un bloque sombra
 *                             `playgo_menu_<menu>` (`{input: 'LED'}`).
 * En PlayGo sólo `rgbLeds` y `digitalState` aceptan reporters.
 *
 * ── LO QUE NO SE TRAE ───────────────────────────────────────────────────────
 *
 * La DEDUPLICACIÓN (`_lastMotorState`, `_lastRgbJson`, `_heldFreq`...) NO se
 * traduce. Existe para proteger el enlace serial/BLE, que en modo autónomo no
 * existe: en la placa `setMotorLeft()` es un `ledcWrite`, y repetirlo 200
 * veces por segundo no cuesta nada.
 */

const {HW, WHEEL, IO_MODE, RGB_ALL} = require('./hw-map');

/** Semitonos desde Do, igual que `_noteToFreq` en playgo/blocks.js:1415. */
const SEMITONES_FROM_C = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11};

/**
 * Frecuencia de una nota, plegada en tiempo de compilación.
 * Réplica exacta de `PlayGoBlocks._noteToFreq()`.
 * @param {string} note Nota ('C'..'B').
 * @param {string} octave Octava ('4'..'7').
 * @returns {number} Frecuencia en Hz, redondeada.
 */
const noteToFreq = function (note, octave) {
    const semitone = SEMITONES_FROM_C[note] || 0;
    const semitonesFromA4 = ((parseInt(octave, 10) - 4) * 12) + (semitone - 9);
    return Math.round(440 * Math.pow(2, semitonesFromA4 / 12));
};

/** Colores con nombre, réplica de la tabla de `setRGBPreset`. */
const RGB_PRESETS = {
    red: [255, 0, 0],
    green: [0, 255, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    white: [255, 255, 255],
    black: [0, 0, 0]
};

/**
 * Descompone un color '#rrggbb' en sus tres componentes.
 * @param {string} hex Color hexadecimal.
 * @returns {Array.<number>} `[r, g, b]`.
 */
const hexToRgb = function (hex) {
    const clean = String(hex).replace('#', '');
    return [
        parseInt(clean.substring(0, 2), 16) || 0,
        parseInt(clean.substring(2, 4), 16) || 0,
        parseInt(clean.substring(4, 6), 16) || 0
    ];
};

/** A/B/C/D son los conectores IO11-IO14 (uso dual servo / salida digital). */
const SERVO_PORT_TO_GPIO = {A: 11, B: 12, C: 13, D: 14};

/** Convierte un reporter numérico (0/1) en un booleano de verdad. */
const AS_BOOLEAN = [
    {op: 'PUSH_I8', operands: [1]},
    {op: 'EQ'}
];

/**
 * Mapea la lectura cruda del ADC de 12 bits (0-4095) a 0-100, igual que hace
 * `analogReadPB` en JS. Se emite como ARITMÉTICA DE BYTECODE, no como una
 * primitiva nueva: el firmware sigue devolviendo la lectura cruda y la placa
 * no necesita saber nada de este mapeo.
 */
const ADC_TO_PERCENT = [
    {op: 'PUSH_I8', operands: [100]},
    {op: 'MUL'},
    {op: 'PUSH_F32', operands: [4095]},
    {op: 'DIV'},
    {op: 'ROUND'}
];

/**
 * Los 37 bloques. Cada entrada:
 *   hw    nombre de la primitiva de hardware (clave de HW)
 *   args  argumentos, EN EL ORDEN que espera la primitiva
 *   post  operaciones de bytecode a aplicar al resultado (sólo reporters)
 *   wait  'arg:<i>' -> tras llamar, esperar los milisegundos del argumento i
 *
 * Tipos de argumento:
 *   {input: 'X', ...}   compila la expresión del input
 *   {field: 'X', map}   pliega el field a una constante (a través de `map`)
 *   {value: n}          constante literal
 *   {fold: fn}          constante calculada por `fn(block, helpers)`
 *
 * Modificadores de input: `coerce: 'int'`, `clamp: [min, max]`, `min`, `max`.
 */
const BLOCKS = {
    // ── Motores ──────────────────────────────────────────────────────────
    playgo_setMotorSpeeds: {
        hw: 'setMotorSpeed',
        args: [
            {input: 'LEFT', coerce: 'int', clamp: [-100, 100]},
            {input: 'RIGHT', coerce: 'int', clamp: [-100, 100]}
        ]
    },
    playgo_stopMotors: {hw: 'stopMotors', args: []},

    // El cálculo de pulsos vive en el FIRMWARE (main.cpp:713-740), así que se
    // le pasan los mismos parámetros que por JSON. El `moveId` no viaja en el
    // bytecode: lo asigna el intérprete y lo guarda para saber qué esperar.
    playgo_moveDistanceCm: {
        hw: 'moveDistance',
        args: [
            {input: 'DISTANCE'},
            {input: 'SPEED', coerce: 'int', clamp: [-100, 100]},
            {input: 'WHEEL_DIAM'},
            {input: 'PULSES_PER_REV', coerce: 'int', min: 1}
        ]
    },
    playgo_turnAngleDeg: {
        hw: 'turnAngle',
        args: [
            {input: 'ANGLE'},
            {input: 'SPEED', coerce: 'int', clamp: [-100, 100]},
            {input: 'WHEEL_DIAM'},
            {input: 'TRACK_WIDTH'},
            {input: 'PULSES_PER_REV', coerce: 'int', min: 1}
        ]
    },
    playgo_turnWheelRevolutions: {
        hw: 'turnWheelRevs',
        args: [
            {field: 'WHEEL', map: WHEEL, fallback: WHEEL.both},
            {input: 'REVOLUTIONS'},
            {input: 'SPEED', coerce: 'int', clamp: [-100, 100]},
            {input: 'PULSES_PER_REV', coerce: 'int', min: 1}
        ]
    },
    playgo_resetEncoders: {hw: 'resetEncoders', args: []},
    playgo_getEncoderPulses: {
        hw: 'readEncoder',
        args: [{field: 'WHEEL', map: {left: 0, right: 1}, fallback: 0}]
    },
    playgo_setServoPlayGo: {
        hw: 'servoWrite',
        args: [
            {field: 'PORT', map: SERVO_PORT_TO_GPIO, fallback: 11},
            {input: 'ANGLE', coerce: 'int', clamp: [0, 180]}
        ]
    },

    // ── Botones ──────────────────────────────────────────────────────────
    playgo_readButtonPlayGo: {
        hw: 'readButton',
        args: [{field: 'BUTTON', coerce: 'int'}],
        post: AS_BOOLEAN
    },

    // ── LEDs RGB ─────────────────────────────────────────────────────────
    // Los cinco bloques RGB colapsan en la MISMA primitiva `setRGB(led,r,g,b)`,
    // con `led = -1` para "todos". Las tablas de colores se pliegan aquí.
    playgo_setRGBColor: {
        hw: 'setRGB',
        args: [
            {input: 'LED', coerce: 'int'},
            {input: 'R', coerce: 'int', clamp: [0, 255]},
            {input: 'G', coerce: 'int', clamp: [0, 255]},
            {input: 'B', coerce: 'int', clamp: [0, 255]}
        ]
    },
    playgo_setRGBColorHex: {
        hw: 'setRGB',
        args: [
            {input: 'LED', coerce: 'int'},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[0]},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[1]},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[2]}
        ]
    },
    playgo_setRGBPreset: {
        hw: 'setRGB',
        args: [
            {input: 'LED', coerce: 'int'},
            {fold: (b, h) => (RGB_PRESETS[h.field(b, 'PRESET')] || RGB_PRESETS.black)[0]},
            {fold: (b, h) => (RGB_PRESETS[h.field(b, 'PRESET')] || RGB_PRESETS.black)[1]},
            {fold: (b, h) => (RGB_PRESETS[h.field(b, 'PRESET')] || RGB_PRESETS.black)[2]}
        ]
    },
    playgo_rgbOff: {
        hw: 'setRGB',
        args: [{input: 'LED', coerce: 'int'}, {value: 0}, {value: 0}, {value: 0}]
    },
    playgo_allRGBOff: {
        hw: 'setRGB',
        args: [{value: RGB_ALL}, {value: 0}, {value: 0}, {value: 0}]
    },
    playgo_setAllRGB: {
        hw: 'setRGB',
        args: [
            {value: RGB_ALL},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[0]},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[1]},
            {fold: (b, h) => hexToRgb(h.field(b, 'COLOR'))[2]}
        ]
    },

    // ── Pantalla OLED ────────────────────────────────────────────────────
    playgo_oledText: {
        hw: 'oledText',
        args: [{input: 'TEXT', coerce: 'string'}, {field: 'SIZE', coerce: 'int'}]
    },
    playgo_oledNumber: {
        hw: 'oledNumber',
        args: [
            {field: 'LINE', coerce: 'int'},
            {input: 'LABEL', coerce: 'string'},
            {input: 'VALUE', coerce: 'int'}
        ]
    },
    playgo_oledClear: {hw: 'oledClear', args: []},
    playgo_oledLine: {
        hw: 'oledLine',
        args: [{field: 'LINE', coerce: 'int'}, {input: 'TEXT', coerce: 'string'}]
    },
    playgo_oledTextXY: {
        hw: 'oledTextXY',
        args: [
            {input: 'TEXT', coerce: 'string'},
            {input: 'X', coerce: 'int'},
            {input: 'Y', coerce: 'int'},
            {field: 'SIZE', coerce: 'int'}
        ]
    },
    // El emoji viaja como TEXTO (el firmware lo traduce a su glifo), así que
    // entra en la tabla de strings del programa.
    playgo_oledEmoji: {
        hw: 'oledEmoji',
        args: [
            {field: 'EMOJI', coerce: 'string'},
            {input: 'X', coerce: 'int'},
            {input: 'Y', coerce: 'int'}
        ]
    },
    playgo_oledDrawLine: {
        hw: 'oledDrawLine',
        args: [
            {input: 'X0', coerce: 'int'}, {input: 'Y0', coerce: 'int'},
            {input: 'X1', coerce: 'int'}, {input: 'Y1', coerce: 'int'}
        ]
    },
    playgo_oledDrawRect: {
        hw: 'oledDrawRect',
        args: [
            {input: 'X', coerce: 'int'}, {input: 'Y', coerce: 'int'},
            {input: 'W', coerce: 'int'}, {input: 'H', coerce: 'int'}
        ]
    },
    playgo_oledFillRect: {
        hw: 'oledFillRect',
        args: [
            {input: 'X', coerce: 'int'}, {input: 'Y', coerce: 'int'},
            {input: 'W', coerce: 'int'}, {input: 'H', coerce: 'int'}
        ]
    },
    playgo_oledDrawCircle: {
        hw: 'oledDrawCircle',
        args: [
            {input: 'X', coerce: 'int'}, {input: 'Y', coerce: 'int'},
            {input: 'R', coerce: 'int'}
        ]
    },
    playgo_oledDrawPixel: {
        hw: 'oledDrawPixel',
        args: [{input: 'X', coerce: 'int'}, {input: 'Y', coerce: 'int'}]
    },
    playgo_oledDisplay: {hw: 'oledDisplay', args: []},

    // ── Audio ────────────────────────────────────────────────────────────
    // `handleTone` + `toneTick()` ya son NO BLOQUEANTES en el firmware, así que
    // "sonar N ms" se compila como la llamada MÁS una espera de N ms. Eso
    // reproduce exactamente lo que hace el handler de JS (que también espera),
    // sin necesitar una primitiva bloqueante.
    playgo_playTone: {
        hw: 'tone',
        args: [
            {input: 'FREQ', coerce: 'int', min: 20},
            {input: 'DURATION', coerce: 'int', min: 1}
        ],
        wait: 'arg:1'
    },
    playgo_playNote: {
        hw: 'tone',
        args: [
            {fold: (b, h) => noteToFreq(h.field(b, 'NOTE'), h.field(b, 'OCTAVE'))},
            {input: 'DURATION', coerce: 'int', min: 1}
        ],
        wait: 'arg:1'
    },
    // duración 0 = "sonar indefinidamente" para el firmware (ver holdNote).
    playgo_holdNote: {
        hw: 'tone',
        args: [
            {fold: (b, h) => noteToFreq(h.field(b, 'NOTE'), h.field(b, 'OCTAVE'))},
            {value: 0}
        ]
    },
    // Silencia SÓLO si suena esta nota. Con un `toneStop` genérico, en el
    // patrón de piano cada rama "si no" apagaría la nota de las demás teclas.
    playgo_releaseNote: {
        hw: 'toneStopIf',
        args: [{fold: (b, h) => noteToFreq(h.field(b, 'NOTE'), h.field(b, 'OCTAVE'))}]
    },
    playgo_stopTone: {hw: 'toneStop', args: []},
    playgo_micLevel: {hw: 'micLevel', args: []},

    // ── playBlocks / play+ ───────────────────────────────────────────────
    playgo_setIOMode: {
        hw: 'setIOMode',
        args: [{field: 'MODE', map: IO_MODE, fallback: IO_MODE.playBlocks}]
    },
    playgo_readDigitalPB: {
        hw: 'readGpio',
        args: [{field: 'PIN', coerce: 'int'}],
        post: AS_BOOLEAN
    },
    playgo_analogReadPB: {
        hw: 'readAnalog',
        args: [{field: 'PIN', coerce: 'int'}],
        post: ADC_TO_PERCENT
    },
    playgo_writeDigitalPB: {
        hw: 'digitalWrite',
        args: [{field: 'PIN', coerce: 'int'}, {input: 'STATE', coerce: 'int'}]
    }
};

// Comprobación de coherencia al cargar el módulo: cada bloque debe apuntar a
// una primitiva que exista y pasarle exactamente los argumentos que espera.
// Es barato y evita que un descuido aquí llegue a producir bytecode inválido.
for (const opcode of Object.keys(BLOCKS)) {
    const spec = BLOCKS[opcode];
    const hw = HW[spec.hw];
    if (!hw) {
        throw new Error(`${opcode} apunta a una primitiva inexistente: "${spec.hw}"`);
    }
    if (hw.argc !== spec.args.length) {
        throw new Error(
            `${opcode} pasa ${spec.args.length} argumento(s) a ${spec.hw}, que espera ${hw.argc}`
        );
    }
}

module.exports = {
    BLOCKS,
    noteToFreq,
    hexToRgb,
    RGB_PRESETS,
    SERVO_PORT_TO_GPIO
};
