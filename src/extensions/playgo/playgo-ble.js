/**
 * Transporte Web Bluetooth (BLE) para PlayGo.
 *
 * El ESP32-S3 NO tiene Bluetooth Classic (BR/EDR), solo BLE — por lo tanto no
 * puede exponer un COM virtual por SPP como los modulos HC-05. En su lugar, el
 * firmware publica un servicio Nordic UART (NUS) y este transporte habla con el
 * via Web Bluetooth (Chrome/Edge). Mismo protocolo JSON-por-linea que el USB:
 * la GUI escribe en la caracteristica RX y recibe telemetria por notificaciones
 * de la caracteristica TX. Interfaz identica a PlayGoSerial (connect/disconnect/
 * write/onData/onDisconnect) para que PlayGoPeripheral pueda usar cualquiera de
 * los dos transportes sin cambiar los bloques.
 */

// UUIDs estandar del Nordic UART Service. Web Bluetooth exige minusculas.
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // GUI -> placa (write)
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // placa -> GUI (notify)

class PlayGoBLE {
    constructor() {
        this.device = null;
        this.rxChar = null;
        this.txChar = null;
        this.connected = false;
        this.buffer = '';
        this._lastRxTime = null;
        // Cadena de escrituras pendientes: dos scripts de Scratch corriendo a
        // la vez (ej. motores por teclado + notas por boton) pueden llamar
        // write() concurrentemente, y sin serializar sus trozos de 20 bytes se
        // intercalarian, corrompiendo ambas lineas JSON en el firmware.
        this._writeChain = Promise.resolve();
        // Notificacion mas grande recibida en esta conexion. Es la EVIDENCIA
        // de que el MTU negociado es grande (una notificacion nunca puede
        // exceder MTU-3): si el firmware nos mando >100 bytes en un solo
        // evento, nuestros comandos (~80-120 bytes) tambien caben en UN
        // write, sin trocear a 20 bytes (5 writes secuenciales = mas latencia).
        this._maxNotifSize = 0;
        // Ciclo de reconexion automatica en curso (evita lanzar dos a la vez).
        this._reconnecting = false;
        // Handler de notificaciones como referencia estable: permite
        // remove+add en cada (re)conexion sin acumular listeners duplicados
        // si Chrome devuelve el mismo objeto characteristic cacheado.
        this._notifyHandler = e => {
            if (e.target.value.byteLength > this._maxNotifSize) {
                this._maxNotifSize = e.target.value.byteLength;
            }
            // Vitalidad del enlace = BYTES recibidos, no JSON validos: si la
            // telemetria llega corrupta (fragmentos perdidos por congestion en
            // el firmware), el enlace sigue VIVO y el watchdog no debe
            // cortarlo por "silencio" -- la corrupcion tiene su propio
            // detector (_validRx en _startWatch).
            this._lastRxTime = Date.now();
            const text = new TextDecoder().decode(e.target.value);
            this.handleIncoming(text);
        };
    }

    /**
     * Abre el picker nativo de Bluetooth del navegador y conecta al dispositivo
     * elegido. Debe llamarse desde un gesto del usuario (click), igual que
     * navigator.serial.requestPort().
     */
    async connect() {
        if (!('bluetooth' in navigator)) {
            throw new Error('Este navegador no soporta Web Bluetooth');
        }

        const device = await navigator.bluetooth.requestDevice({
            // Filtrar por el servicio NUS que anuncia el firmware: solo aparecen
            // placas PlayGo (u otros dispositivos NUS), no todo el entorno BLE.
            filters: [{ services: [NUS_SERVICE] }]
        });

        this.device = device;
        device.addEventListener('gattserverdisconnected', () => this._handleUnexpectedDisconnect());

        await this._openGatt();
        console.log('[PlayGo BLE] Conectado a', device.name || '(sin nombre)');
    }

    /**
     * Abre (o reabre) la sesion GATT sobre this.device: servicio, caracteristicas,
     * notificaciones y watchdog. Compartido entre la conexion inicial (connect)
     * y la reconexion automatica (_autoReconnect) — Web Bluetooth permite
     * reconectar a un dispositivo ya autorizado sin gesto del usuario.
     */
    async _openGatt() {
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(NUS_SERVICE);
        this.rxChar = await service.getCharacteristic(NUS_RX);
        this.txChar = await service.getCharacteristic(NUS_TX);

        await this.txChar.startNotifications();
        this.txChar.removeEventListener('characteristicvaluechanged', this._notifyHandler);
        this.txChar.addEventListener('characteristicvaluechanged', this._notifyHandler);

        this.buffer = '';
        this._maxNotifSize = 0;
        this._writeChain = Promise.resolve();
        this.connected = true;
        this._lastRxTime = Date.now();
        this._openedAt = Date.now();
        this._validRx = 0;
        this._startWatch();
    }

    /**
     * Vigilancia del enlace (cada 2s): (a) si la telemetria (10Hz, o 2.5Hz con
     * MTU minimo) lleva sin llegar mas que el umbral, el enlace esta muerto
     * aunque Chrome no haya disparado gattserverdisconnected — cortar y pasar
     * al ciclo de reconexion. (b) ping al firmware: mantiene fresco su watchdog
     * de trafico entrante (si la placa deja de recibirlo >25s, corta y
     * re-anuncia por su cuenta). Ademas, si el write del ping falla, ese error
     * delata el enlace muerto por la via rapida (ver _writeMsg).
     *
     * Umbral en 12s (antes 6s, v2.1.2): este watchdog llama gatt.disconnect(),
     * que el firmware ve EXACTAMENTE como "el PC corto la conexion" (razon HCI
     * 0x13) — si Windows atrasa la telemetria unos segundos (throttling de
     * energia, pestana en segundo plano), un umbral corto remata conexiones
     * que siguen vivas. 12s da margen a esos microcortes sin dejar de detectar
     * un enlace genuinamente muerto en tiempo razonable.
     */
    _startWatch() {
        this._clearWatchTimer();
        this._watchTimer = setInterval(() => {
            if (!this.connected) return;
            if (this._lastRxTime && Date.now() - this._lastRxTime > 12000) {
                console.warn('[PlayGo BLE] Sin telemetría >12s, enlace muerto — reconectando');
                this._handleUnexpectedDisconnect();
                return;
            }
            // Sesion "enferma": llegan bytes pero NINGUNA linea parsea como
            // JSON valido tras 10s -- visto en campo cuando el firmware queda
            // troceando al MTU minimo y la congestion mutila las lineas. Una
            // conexion fresca renegocia MTU/parametros desde cero y
            // normalmente sale sana: forzar el ciclo de reconexion.
            if (this._openedAt && Date.now() - this._openedAt > 10000 && this._validRx === 0) {
                console.warn('[PlayGo BLE] Telemetría corrupta persistente, renegociando conexión...');
                this._handleUnexpectedDisconnect();
                return;
            }
            this.write('{"command":"ping"}');
        }, 2000);
    }

    _clearWatchTimer() {
        if (this._watchTimer) {
            clearInterval(this._watchTimer);
            this._watchTimer = null;
        }
    }

    _handleUnexpectedDisconnect() {
        if (!this.connected) return;
        // Diagnostico: cuanto hacia que no llegaba telemetria al momento del
        // corte. Si es bajo (<1s), el enlace murio de golpe (corte externo);
        // si es alto (~12s), fue este watchdog quien lo declaro muerto.
        const sinceRx = this._lastRxTime ? Date.now() - this._lastRxTime : -1;
        console.warn(`[PlayGo BLE] Enlace caído (última telemetría hace ${sinceRx}ms) — reconexión automática...`);
        this.connected = false;
        this._clearWatchTimer();
        this.rxChar = null;
        this.txChar = null;
        this._autoReconnect();
    }

    /**
     * Reconexion automatica (v2.1.2): Web Bluetooth permite volver a llamar
     * device.gatt.connect() sobre un dispositivo ya autorizado SIN abrir el
     * picker. El firmware se re-anuncia solo tras cualquier desconexion, asi
     * que aunque Windows/Chrome corten el enlace "de la nada" (razon 0x13),
     * la sesion se recupera sola en ~1-2s y el usuario ni se entera. Solo si
     * fallan todos los reintentos se notifica la desconexion a la UI.
     */
    async _autoReconnect() {
        if (this._reconnecting) return;
        this._reconnecting = true;

        // Asegurar que la sesion GATT anterior quede cerrada antes de reabrir
        // (si el corte lo declaro nuestro watchdog, Chrome aun la cree viva).
        // Esto ademas libera la sesion del stack BLE de Windows — sin ese
        // cierre, quedaba una sesion zombi que bloqueaba reconexiones hasta
        // reiniciar el Bluetooth del PC.
        try {
            if (this.device && this.device.gatt && this.device.gatt.connected) {
                this.device.gatt.disconnect();
            }
        } catch (e) { /* ignorar */ }

        const delaysMs = [1000, 2000, 3000, 4000, 5000];
        for (const delay of delaysMs) {
            await new Promise(resolve => setTimeout(resolve, delay));
            // El usuario desconecto manualmente durante los reintentos: parar.
            if (!this.device) break;
            try {
                await this._openGatt();
                this._reconnecting = false;
                console.log('[PlayGo BLE] Reconectado automáticamente');
                return;
            } catch (err) {
                console.warn('[PlayGo BLE] Reintento de conexión falló:', err.message || err);
                // Quirk conocido de Chrome tras una desconexion: gatt.connect()
                // resuelve desde el estado cacheado pero el enlace real no
                // esta arriba, y getPrimaryService() falla con "GATT Server is
                // disconnected" (visto en campo tal cual). Cerrar la sesion
                // rancia antes del proximo intento para que el siguiente
                // connect() abra un enlace de verdad.
                try {
                    if (this.device && this.device.gatt && this.device.gatt.connected) {
                        this.device.gatt.disconnect();
                    }
                } catch (e) { /* ignorar */ }
            }
        }

        this._reconnecting = false;
        console.error('[PlayGo BLE] Reconexión automática agotada — desconectando');
        try {
            if (this.device && this.device.gatt && this.device.gatt.connected) {
                this.device.gatt.disconnect();
            }
        } catch (e) { /* ignorar */ }
        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    async disconnect() {
        this.connected = false;
        this._clearWatchTimer();
        this.rxChar = null;
        this.txChar = null;
        try {
            if (this.device && this.device.gatt && this.device.gatt.connected) {
                this.device.gatt.disconnect();
            }
        } catch (e) { /* ignorar */ }
        // device=null tambien frena cualquier ciclo de reconexion en curso.
        this.device = null;
        this.buffer = '';
        console.log('[PlayGo BLE] Desconectado');
    }

    // Mismo framing por lineas que PlayGoSerial: las notificaciones BLE llegan
    // en trozos arbitrarios (limitados por el MTU), el '\n' delimita mensajes.
    handleIncoming(text) {
        this.buffer += text;

        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith('{') && line.endsWith('}')) {
                try {
                    const data = JSON.parse(line);
                    this._validRx = (this._validRx || 0) + 1;
                    if (this.onData) {
                        this.onData(data);
                    }
                } catch (err) {
                    if (line.includes('"inputs"') || line.includes('"ok"')) {
                        console.warn('[PlayGo BLE] JSON inválido:', line.substring(0, 60));
                    }
                }
            }
        }

        if (this.buffer.length > 1024) {
            console.warn('[PlayGo BLE] Buffer muy grande, limpiando');
            const lastBrace = this.buffer.lastIndexOf('{');
            this.buffer = lastBrace !== -1 ? this.buffer.substring(lastBrace) : '';
        }
    }

    write(msg) {
        if (!this.rxChar || !this.connected) {
            // Durante una reconexion automatica los bloques pueden seguir
            // mandando comandos; se descartan en silencio esos ~1-5s en vez
            // de llenar la consola de errores.
            if (!this._reconnecting) console.error('[PlayGo BLE] No hay conexión activa');
            return Promise.resolve();
        }

        // Encolar detras de cualquier escritura en curso (ver _writeChain en el
        // constructor). El catch corta la propagacion del error a las escrituras
        // siguientes de la cadena; _writeMsg ya lo logueo.
        this._writeChain = this._writeChain
            .then(() => this._writeMsg(msg))
            .catch(() => {});
        return this._writeChain;
    }

    async _writeMsg(msg) {
        if (!this.rxChar || !this.connected) return;
        try {
            const data = new TextEncoder().encode(msg + '\n');
            const writeOne = slice => (this.rxChar.writeValueWithoutResponse
                ? this.rxChar.writeValueWithoutResponse(slice)
                : this.rxChar.writeValue(slice));

            // Si ya recibimos una notificacion grande del firmware, el MTU
            // negociado es comprobadamente grande y el comando completo cabe
            // en UN solo write (menos latencia que 5+ writes secuenciales de
            // 20 bytes). Si no hay evidencia, trocear a 20 bytes -- el payload
            // garantizado con el MTU minimo (23-3). El firmware re-ensambla
            // por '\n', asi que la fragmentacion es transparente en ambos casos.
            const singleWriteOk = this._maxNotifSize > 100 &&
                data.length <= this._maxNotifSize;
            if (singleWriteOk) {
                await writeOne(data);
            } else {
                const CHUNK = 20;
                for (let i = 0; i < data.length; i += CHUNK) {
                    await writeOne(data.slice(i, i + CHUNK));
                }
            }
            console.log('[PlayGo BLE] TX:', msg);
        } catch (err) {
            console.error('[PlayGo BLE] Error enviando datos:', err);
            // Un write GATT fallido con el enlace "conectado" delata que el
            // enlace en realidad murio (tipico: "GATT Server is disconnected"
            // sin que Chrome disparara el evento). Cortar y pasar al ciclo de
            // reconexion automatica de una vez.
            const emsg = (err && err.message) || '';
            if (err && (err.name === 'NetworkError' || emsg.includes('GATT') || emsg.includes('disconnect'))) {
                this._handleUnexpectedDisconnect();
            }
            throw err;
        }
    }
}

module.exports = PlayGoBLE;
