/**
 * Estado y protocolo del control remoto.
 *
 * Lo comparten DOS clientes que no se conocen entre sí:
 *   1. El peripheral de PlayGo (modo en vivo dentro del editor).
 *   2. La página suelta del mando (`playground/control.jsx`), pensada para el
 *      celular, que abre su propia conexión sin pasar por el editor.
 *
 * Vive aquí y no duplicado en cada uno porque la forma exacta de la línea y el
 * ritmo del latido tienen que ser IDÉNTICOS en ambos: si divergieran, un mando
 * dejaría de mantener vivos los botones del otro y el fallo aparecería sólo en
 * el aula, con el robot ignorando el control sin decir por qué.
 */

/**
 * Los ocho botones, en el orden que espera el firmware (el índice ES el bit).
 * La cruceta primero y las acciones después: es la disposición de mando que
 * cualquier niño reconoce, y coincide con el menú del bloque de Scratch.
 */
const REMOTE_BUTTONS = [
    {index: 0, id: 'up', label: 'Arriba', glyph: '▲'},
    {index: 1, id: 'down', label: 'Abajo', glyph: '▼'},
    {index: 2, id: 'left', label: 'Izquierda', glyph: '◀'},
    {index: 3, id: 'right', label: 'Derecha', glyph: '▶'},
    {index: 4, id: 'a', label: 'A', glyph: 'A'},
    {index: 5, id: 'b', label: 'B', glyph: 'B'},
    {index: 6, id: 'c', label: 'C', glyph: 'C'},
    {index: 7, id: 'd', label: 'D', glyph: 'D'}
];

/**
 * Cada cuánto se reenvía el estado aunque no haya cambiado.
 *
 * El firmware apaga todos los botones si pasa medio segundo sin recibir nada,
 * así que este reenvío es lo que significa "sigo aquí". Debe quedar holgado
 * por debajo de ese medio segundo para que un paquete perdido no apague los
 * botones en mitad de una curva.
 */
const HEARTBEAT_MS = 200;

/**
 * Teclas del teclado físico que valen como botones del mando. Existe para que
 * un computador sirva de control sin ratón, y para que el flujo que un niño ya
 * conoce ("las flechas mueven cosas") siga valiendo aquí.
 */
const KEY_MAP = {
    ArrowUp: 0,
    KeyW: 0,
    ArrowDown: 1,
    KeyS: 1,
    ArrowLeft: 2,
    KeyA: 2,
    ArrowRight: 3,
    KeyD: 3,
    Space: 4,
    KeyZ: 4,
    KeyX: 5,
    KeyC: 6,
    KeyV: 7
};

class RemoteControl {
    /**
     * @param {Function} send Envía una línea del protocolo. Puede devolver una
     *     promesa; los fallos se ignoran a propósito (ver `_flush`).
     */
    constructor (send) {
        this._send = send;
        this._mask = 0;
        this._heartbeat = null;
    }

    /** @returns {number} Máscara actual, un bit por botón. */
    get mask () {
        return this._mask;
    }

    /** @returns {boolean} True si el latido está activo. */
    get active () {
        return this._heartbeat !== null;
    }

    /**
     * Empieza a mandar. Manda el estado vacío de entrada, para que la placa
     * arranque con todos los botones sueltos aunque venga de otra sesión.
     */
    start () {
        if (this._heartbeat) return;
        this._mask = 0;
        this._flush();
        this._heartbeat = setInterval(() => this._flush(), HEARTBEAT_MS);
    }

    /**
     * Suelta todos los botones y deja de mandar.
     *
     * Se manda el cero explícitamente en vez de confiar sólo en que la placa
     * lo note por silencio: si el enlace sigue vivo, el robot para AHORA y no
     * medio segundo después.
     */
    stop () {
        if (this._heartbeat) {
            clearInterval(this._heartbeat);
            this._heartbeat = null;
        }
        this._mask = 0;
        this._flush();
    }

    /**
     * @param {number} index Botón 0-7.
     * @param {boolean} pressed Si está presionado.
     * @returns {boolean} True si el estado cambió de verdad.
     */
    setButton (index, pressed) {
        const i = parseInt(index, 10);
        if (isNaN(i) || i < 0 || i > 7) return false;
        const bit = 1 << i;
        const next = pressed ? (this._mask | bit) : (this._mask & ~bit);
        if (next === this._mask) return false;
        this._mask = next;
        // Se manda en el momento, sin esperar al latido: al pulsar, la
        // respuesta tiene que sentirse inmediata.
        this._flush();
        return true;
    }

    /**
     * @param {number} index Botón 0-7.
     * @returns {boolean} True si ese botón está presionado.
     */
    isPressed (index) {
        const i = parseInt(index, 10);
        if (isNaN(i) || i < 0 || i > 7) return false;
        return (this._mask & (1 << i)) !== 0;
    }

    /** Suelta todos los botones sin detener el latido (al perder el foco). */
    releaseAll () {
        if (this._mask === 0) return;
        this._mask = 0;
        this._flush();
    }

    /**
     * @returns {string} La línea del protocolo para el estado actual.
     */
    line () {
        return JSON.stringify({
            command: 'outputsQueue',
            testValue: [{command: 'remoteKeys', mask: this._mask}]
        });
    }

    /**
     * Manda el estado. NO se deduplica a propósito: reenviar el mismo valor es
     * exactamente lo que mantiene vivos los botones en la placa.
     */
    _flush () {
        try {
            const result = this._send(this.line());
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (e) {
            // Un envío fallido no debe tumbar el latido: el enlace puede estar
            // reconectando y el siguiente pulso saldrá bien.
        }
    }
}

module.exports = RemoteControl;
module.exports.REMOTE_BUTTONS = REMOTE_BUTTONS;
module.exports.HEARTBEAT_MS = HEARTBEAT_MS;
module.exports.KEY_MAP = KEY_MAP;
