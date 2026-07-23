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

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(NUS_SERVICE);
        this.rxChar = await service.getCharacteristic(NUS_RX);
        this.txChar = await service.getCharacteristic(NUS_TX);

        await this.txChar.startNotifications();
        this.txChar.addEventListener('characteristicvaluechanged', e => {
            if (e.target.value.byteLength > this._maxNotifSize) {
                this._maxNotifSize = e.target.value.byteLength;
            }
            const text = new TextDecoder().decode(e.target.value);
            this.handleIncoming(text);
        });

        this.buffer = '';
        this._maxNotifSize = 0;
        this.connected = true;
        this._lastRxTime = Date.now();

        // Vigilancia del enlace (cada 2s): (a) si la telemetria (10Hz, o
        // 2.5Hz con MTU minimo) lleva sin llegar mas que el umbral, el enlace
        // esta muerto aunque Chrome no haya disparado gattserverdisconnected
        // -- cortar y avisar a la UI (antes quedaba "conectado" en pantalla
        // pero muerto). (b) ping al firmware: mantiene fresco su watchdog de
        // trafico entrante (si la placa deja de recibirlo >15s, corta y
        // re-anuncia por su cuenta). Ademas, si el write del ping falla, ese
        // error delata el enlace muerto por la via rapida (ver _writeMsg).
        //
        // Umbral en 12s (antes 6s, v2.1.2): se detecto que ESTE watchdog
        // podia ser la causa de desconexiones reportadas como "el PC corto
        // la conexion" (razon HCI 0x13 en el firmware) -- si Windows pausa
        // brevemente el radio BLE para ahorro de energia (adaptador con
        // "permitir apagar para ahorrar energia" activo), la telemetria se
        // atrasa unos segundos sin que el enlace este realmente muerto, y
        // este codigo llamaba gatt.disconnect() de forma prematura, lo cual
        // el firmware ve exactamente como "el PC termino la conexion". 12s
        // da mas margen a esos microcortes de radio sin dejar de detectar
        // un enlace genuinamente muerto en tiempo razonable.
        this._watchTimer = setInterval(() => {
            if (!this.connected) return;
            if (this._lastRxTime && Date.now() - this._lastRxTime > 12000) {
                console.warn('[PlayGo BLE] Sin telemetría >12s, enlace muerto — desconectando');
                this._handleUnexpectedDisconnect();
                return;
            }
            this.write('{"command":"ping"}');
        }, 2000);

        console.log('[PlayGo BLE] Conectado a', device.name || '(sin nombre)');
    }

    _clearWatchTimer() {
        if (this._watchTimer) {
            clearInterval(this._watchTimer);
            this._watchTimer = null;
        }
    }

    _handleUnexpectedDisconnect() {
        if (!this.connected) return;
        console.log('[PlayGo BLE] Dispositivo desconectado');
        this.connected = false;
        this._clearWatchTimer();
        this.rxChar = null;
        this.txChar = null;
        // Cerrar el GATT explicitamente: sin esto, el stack BLE de Windows se
        // quedaba con la sesion muerta a medio abrir y no permitia reconectar
        // hasta reiniciar el Bluetooth del PC.
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
                    this._lastRxTime = Date.now();
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
            console.error('[PlayGo BLE] No hay conexión activa');
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
            // sin que Chrome disparara el evento). Cortar limpio de una vez
            // en vez de dejar la sesion zombi que ademas bloqueaba
            // reconexiones hasta reiniciar el Bluetooth del PC.
            const emsg = (err && err.message) || '';
            if (err && (err.name === 'NetworkError' || emsg.includes('GATT') || emsg.includes('disconnect'))) {
                this._handleUnexpectedDisconnect();
            }
            throw err;
        }
    }
}

module.exports = PlayGoBLE;
