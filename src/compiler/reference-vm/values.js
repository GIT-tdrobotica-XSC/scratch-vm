/**
 * Modelo de valores del bytecode y coerciones, fieles a Scratch.
 *
 * Un valor es `{type, num|str|bool}` con type en VAL_NUM / VAL_STR / VAL_BOOL.
 *
 * Dos decisiones que hay que respetar al portar esto a C++:
 *
 * 1. **float32, no float64.** El ESP32-S3 tiene FPU de precisión simple por
 *    hardware; `double` se emula en software y cuesta caro. Aquí se aplica
 *    `Math.fround()` en CADA operación aritmética para que los tests en JS
 *    reproduzcan exactamente lo que hará la placa. Sin ese `fround`, los tests
 *    pasarían con la precisión de JS y la divergencia sólo aparecería en el
 *    aula, que es justo donde no se puede depurar.
 *
 * 2. **VAL_BOOL es un tipo aparte**, aunque no cueste bytes (cabe en la unión).
 *    Es lo único que hace que `unir <botón presionado> "!"` dé `"true!"` como
 *    en Scratch, en vez de `"1!"`.
 */

/** @enum {number} */
const VAL = {
    NUM: 0,
    STR: 1,
    BOOL: 2
};

/**
 * @param {number} n Número.
 * @returns {object} Valor numérico (redondeado a precisión simple).
 */
const num = n => ({type: VAL.NUM, num: Math.fround(n)});

/**
 * @param {string} s Texto.
 * @returns {object} Valor de texto.
 */
const str = s => ({type: VAL.STR, str: s});

/**
 * @param {boolean} b Booleano.
 * @returns {object} Valor booleano.
 */
const bool = b => ({type: VAL.BOOL, bool: !!b});

/**
 * Convierte a número con la semántica de Scratch (lo no numérico vale 0, y NaN
 * también: Scratch nunca propaga NaN a los bloques).
 * @param {object} v Valor.
 * @returns {number} Número en precisión simple.
 */
const toNumber = function (v) {
    switch (v.type) {
    case VAL.NUM:
        return isNaN(v.num) ? 0 : v.num;
    case VAL.BOOL:
        return v.bool ? 1 : 0;
    case VAL.STR: {
        const n = Number(v.str);
        return isNaN(n) ? 0 : Math.fround(n);
    }
    default:
        return 0;
    }
};

/**
 * Convierte a texto con la semántica de Scratch.
 * @param {object} v Valor.
 * @returns {string} Texto.
 */
const toString = function (v) {
    switch (v.type) {
    case VAL.STR:
        return v.str;
    case VAL.BOOL:
        return v.bool ? 'true' : 'false';
    case VAL.NUM:
        return String(v.num);
    default:
        return '';
    }
};

/**
 * Convierte a booleano con la semántica de Scratch: son falsy el 0, la cadena
 * vacía, "0" y "false" (sin distinguir mayúsculas).
 * @param {object} v Valor.
 * @returns {boolean} Verdad lógica.
 */
const toBoolean = function (v) {
    switch (v.type) {
    case VAL.BOOL:
        return v.bool;
    case VAL.NUM:
        return v.num !== 0 && !isNaN(v.num);
    case VAL.STR: {
        const s = v.str;
        if (s === '' || s === '0') return false;
        return s.toLowerCase() !== 'false';
    }
    default:
        return false;
    }
};

/**
 * Comparación de Scratch: numérica si AMBOS lados parecen números; si no,
 * comparación de texto sin distinguir mayúsculas.
 * @param {object} a Izquierdo.
 * @param {object} b Derecho.
 * @returns {number} <0, 0 o >0.
 */
const compare = function (a, b) {
    const looksNumeric = v => {
        if (v.type === VAL.NUM || v.type === VAL.BOOL) return true;
        return v.str.trim() !== '' && !isNaN(Number(v.str));
    };

    if (looksNumeric(a) && looksNumeric(b)) {
        const na = toNumber(a);
        const nb = toNumber(b);
        if (na < nb) return -1;
        if (na > nb) return 1;
        return 0;
    }

    const sa = toString(a).toLowerCase();
    const sb = toString(b).toLowerCase();
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
};

module.exports = {
    VAL,
    num,
    str,
    bool,
    toNumber,
    toString,
    toBoolean,
    compare
};
