/**
 * Errores y avisos del compilador.
 *
 * Cuatro reglas que importan tanto como el catálogo en sí:
 *
 * 1. **Se reportan TODOS los errores, no el primero.** Un niño que puso tres
 *    bloques de teclado tiene que verlos los tres de una vez, no arreglar uno,
 *    reintentar, y descubrir el siguiente.
 * 2. **Avisos != errores.** Cosas cosméticas (una variable "mostrar", bloques
 *    colgando después de un `por siempre`) compilan igual y sólo avisan. No se
 *    bloquea a un niño por algo que no rompe nada.
 * 3. **Los mensajes van dirigidos al niño o al profesor**, no al programador:
 *    dicen qué pasa y qué hacer, sin jerga.
 * 4. **Cada error lleva `blockId`**, para que la GUI pueda resaltar el bloque
 *    culpable en el área de trabajo. Un error que no se puede señalar en
 *    pantalla no sirve de nada a los 9 años.
 */

/** @enum {string} */
const ErrorCode = {
    /** Bloque que sólo funciona con el computador conectado. */
    NEEDS_COMPUTER: 'NEEDS_COMPUTER',
    /** "Mis bloques" (procedimientos). */
    PROCEDURE_UNSUPPORTED: 'PROCEDURE_UNSUPPORTED',
    /** Listas. */
    LIST_UNSUPPORTED: 'LIST_UNSUPPORTED',
    /** Mensajes (broadcast). */
    BROADCAST_UNSUPPORTED: 'BROADCAST_UNSUPPORTED',
    /** Bloque de otra categoría que no puede correr en la placa. */
    UNSUPPORTED_BLOCK: 'UNSUPPORTED_BLOCK',
    /** Un menú que necesita un valor fijo recibió un reporter. */
    MENU_NEEDS_CONSTANT: 'MENU_NEEDS_CONSTANT',
    /** No hay ningún script que empiece con bandera verde. */
    NO_HAT: 'NO_HAT',
    /** Demasiadas banderas verdes. */
    TOO_MANY_THREADS: 'TOO_MANY_THREADS',
    /** Demasiadas variables. */
    TOO_MANY_VARS: 'TOO_MANY_VARS',
    /** Demasiados textos distintos. */
    TOO_MANY_STRINGS: 'TOO_MANY_STRINGS',
    /** El bytecode no cabe en la placa. */
    PROGRAM_TOO_BIG: 'PROGRAM_TOO_BIG',
    /** Expresiones anidadas más allá de la pila del intérprete. */
    STACK_TOO_DEEP: 'STACK_TOO_DEEP',
    /** Bucles anidados más allá de la pila de bucles. */
    LOOPS_TOO_DEEP: 'LOOPS_TOO_DEEP'
};

/** @enum {string} */
const WarningCode = {
    /** Bloque sin efecto en la placa (se compila como nada). */
    NO_EFFECT: 'NO_EFFECT',
    /** Bloques colgando después de un `por siempre`: nunca se ejecutan. */
    UNREACHABLE: 'UNREACHABLE',
    /** Script suelto, sin sombrero: no se ejecutará. */
    ORPHAN_SCRIPT: 'ORPHAN_SCRIPT'
};

/**
 * Nombres legibles de los bloques estándar de Scratch, en español, para que
 * los mensajes digan «el bloque "tecla presionada"» y no
 * «el bloque sensing_keypressed».
 *
 * Se mantienen aquí (y no se leen de la GUI) para que el compilador siga
 * siendo probable en Node, sin navegador ni traducciones cargadas.
 * @type {Object.<string, string>}
 */
const BLOCK_NAMES = {
    sensing_keypressed: 'tecla presionada',
    sensing_mousedown: 'ratón presionado',
    sensing_mousex: 'posición x del ratón',
    sensing_mousey: 'posición y del ratón',
    sensing_askandwait: 'preguntar y esperar',
    sensing_answer: 'respuesta',
    sensing_loudness: 'volumen del micrófono del computador',
    sensing_touchingobject: 'tocando',
    sensing_distanceto: 'distancia a',
    sensing_username: 'nombre de usuario',
    sensing_dayssince2000: 'días desde 2000',
    sensing_current: 'fecha y hora actual',
    sensing_of: 'propiedad de',
    event_whenkeypressed: 'al presionar tecla',
    event_whenthisspriteclicked: 'al hacer clic en este objeto',
    event_whenbroadcastreceived: 'al recibir mensaje',
    event_broadcast: 'enviar mensaje',
    event_broadcastandwait: 'enviar mensaje y esperar',
    event_whengreaterthan: 'cuando el valor sea mayor que',
    event_whenbackdropswitchesto: 'al cambiar el fondo',
    control_create_clone_of: 'crear clon',
    control_delete_this_clone: 'borrar este clon',
    control_start_as_clone: 'al comenzar como clon',
    looks_say: 'decir',
    looks_sayforsecs: 'decir por segundos',
    looks_think: 'pensar',
    looks_switchcostumeto: 'cambiar disfraz',
    looks_nextcostume: 'siguiente disfraz',
    looks_show: 'mostrar',
    looks_hide: 'esconder',
    motion_movesteps: 'mover pasos',
    motion_turnright: 'girar a la derecha',
    motion_turnleft: 'girar a la izquierda',
    motion_gotoxy: 'ir a x y',
    sound_play: 'tocar sonido',
    sound_playuntildone: 'tocar sonido hasta que termine',
    data_addtolist: 'añadir a la lista',
    data_deleteoflist: 'borrar de la lista',
    data_itemoflist: 'elemento de la lista',
    data_lengthoflist: 'largo de la lista',
    data_listcontainsitem: 'la lista contiene',
    data_showvariable: 'mostrar variable',
    data_hidevariable: 'esconder variable'
};

/**
 * Error de compilación. Lleva el `blockId` para que la GUI pueda resaltar en
 * pantalla exactamente el bloque que hay que arreglar.
 */
class CompileError extends Error {
    /**
     * @param {string} code Código de ErrorCode.
     * @param {string} message Mensaje en español, dirigido al usuario.
     * @param {object} [options] Datos adicionales.
     * @param {string} [options.blockId] Bloque culpable.
     * @param {string} [options.opcode] Opcode del bloque culpable.
     * @param {string} [options.hint] Qué hacer para arreglarlo.
     */
    constructor (code, message, options) {
        super(message);
        const opts = options || {};
        this.name = 'CompileError';
        this.code = code;
        this.blockId = opts.blockId || null;
        this.opcode = opts.opcode || null;
        this.hint = opts.hint || null;
    }
}

/**
 * Conjunto de errores de una compilación fallida.
 *
 * Se lanza esto (y no un array pelado) para que quien lo capture pueda hacer
 * `instanceof` y para que el mensaje resuma el problema aunque nadie mire
 * `.errors`. La lista completa importa: un niño con tres bloques malos tiene
 * que verlos los tres resaltados de una vez.
 */
class CompileErrorGroup extends Error {
    /**
     * @param {Array.<CompileError>} errors Errores encontrados.
     */
    constructor (errors) {
        const count = errors.length;
        super(count === 1 ?
            errors[0].message :
            `Tu programa tiene ${count} cosas que arreglar antes de subirlo al robot.`);
        this.name = 'CompileErrorGroup';
        this.errors = errors;
    }
}

/**
 * Nombre legible de un bloque, para meterlo en un mensaje de error.
 * @param {string} opcode Opcode del bloque.
 * @returns {string} Nombre en español, o el opcode si no se conoce.
 */
const blockName = function (opcode) {
    return BLOCK_NAMES[opcode] || opcode;
};

/**
 * Construye el error adecuado para un bloque no soportado, eligiendo el
 * mensaje según POR QUÉ no se soporta. La diferencia importa: "necesita el
 * computador" tiene solución (usar los botones de la placa) y "todavía no
 * funciona" no la tiene, y decirlo mal manda al usuario a buscar donde no hay.
 *
 * @param {object} block Bloque `{id, opcode}`.
 * @returns {CompileError} El error correspondiente.
 */
const unsupportedBlockError = function (block) {
    const {opcode, id} = block;
    const name = blockName(opcode);

    // Bloques que leen periféricos del computador: sin PC no existen.
    const NEEDS_PC = new RegExp(
        '^sensing_(keypressed|mouse|askandwait|answer|loudness|touching|' +
        'distanceto|username|dayssince2000|current|of)'
    );
    if (NEEDS_PC.test(opcode) || opcode === 'event_whenkeypressed') {
        return new CompileError(
            ErrorCode.NEEDS_COMPUTER,
            `El bloque «${name}» necesita el computador conectado, así que no ` +
            `puede funcionar cuando el robot anda solo.`,
            {
                blockId: id,
                opcode,
                hint: 'Puedes usar los botones o los sensores de la placa en su lugar.'
            }
        );
    }

    if (opcode.startsWith('procedures_')) {
        return new CompileError(
            ErrorCode.PROCEDURE_UNSUPPORTED,
            'Por ahora "Mis bloques" no se puede subir a la placa.',
            {
                blockId: id,
                opcode,
                hint: 'Copia los bloques que están dentro de tu bloque directamente en el programa.'
            }
        );
    }

    if (/^data_.*list/i.test(opcode)) {
        return new CompileError(
            ErrorCode.LIST_UNSUPPORTED,
            'Las listas todavía no funcionan cuando el robot anda solo.',
            {blockId: id, opcode, hint: 'Prueba usando variables en lugar de listas.'}
        );
    }

    if (opcode.startsWith('event_broadcast') || opcode === 'event_whenbroadcastreceived') {
        return new CompileError(
            ErrorCode.BROADCAST_UNSUPPORTED,
            'Los mensajes todavía no funcionan cuando el robot anda solo.',
            {blockId: id, opcode, hint: 'Puedes usar una variable para comunicar tus scripts.'}
        );
    }

    if (/clone/i.test(opcode)) {
        return new CompileError(
            ErrorCode.UNSUPPORTED_BLOCK,
            'Los clones no existen en el robot: la placa es una sola.',
            {blockId: id, opcode}
        );
    }

    if (/^(looks_|motion_|sound_)/.test(opcode)) {
        return new CompileError(
            ErrorCode.UNSUPPORTED_BLOCK,
            `El bloque «${name}» mueve o dibuja cosas en la pantalla del ` +
            `computador, y el robot no tiene pantalla de esas.`,
            {blockId: id, opcode}
        );
    }

    return new CompileError(
        ErrorCode.UNSUPPORTED_BLOCK,
        `El bloque «${name}» todavía no funciona cuando el robot anda solo.`,
        {blockId: id, opcode}
    );
};

/**
 * Aviso de compilación: no impide subir el programa.
 * @param {string} code Código de WarningCode.
 * @param {string} message Mensaje en español.
 * @param {string} [blockId] Bloque relacionado.
 * @returns {object} El aviso.
 */
const warning = function (code, message, blockId) {
    return {code, message, blockId: blockId || null};
};

module.exports = {
    ErrorCode,
    WarningCode,
    CompileError,
    CompileErrorGroup,
    BLOCK_NAMES,
    blockName,
    unsupportedBlockError,
    warning
};
