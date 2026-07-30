/**
 * Transporte USB (Web Serial) para PlayBoard + PlayShield V2.
 *
 * El MCU es un ATmega328p (Arduino UNO). A diferencia de los dispositivos
 * ESP32 (PlayMe/PlayGo con USB-JTAG nativo), el UNO usa un puente USB-serial
 * (ATmega16U2 o CH340) que **auto-resetea la placa al abrir el puerto** vía la
 * línea DTR: al conectar, el bootloader (optiboot) corre ~1s antes de que el
 * sketch arranque. Por eso, igual que PlayIoT, aquí se hace un pulso DTR/RTS
 * explícito y se espera ~1s a que el sketch se estabilice antes de leer.
 *
 * Mismo protocolo JSON-por-línea que los demás dispositivos. Interfaz idéntica
 * a las otras clases de transporte (connect/disconnect/write/onData/
 * onDisconnect) para que PlayBoardPeripheral la use sin conocer detalles.
 */
class PlayBoardSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
        this.readableStreamClosed = null;
        this.writableStreamClosed = null;
        this._lastRxTime = null;
    }

    async connect(port) {
        if (!port) {
            console.error('[PlayBoard] No se proporcionó puerto');
            return;
        }

        await this._cleanupBeforeReconnect();

        this.port = port;

        try {
            // Tras una desconexión abrupta, Chrome deja port.readable/writable
            // como streams en error (no null). Cerrar antes de reabrir.
            if (this.port.readable !== null || this.port.writable !== null) {
                try { await this.port.close(); } catch (e) { }
            }

            await this.port.open({ baudRate: 115200 });

            this.keepReading = true;
            this.connected = true;
            this.buffer = '';

            // Reset por hardware del Arduino UNO: pulso DTR/RTS. El UNO se
            // resetea al bajar DTR; tras el pulso, optiboot corre ~1s y luego
            // arranca el sketch. Sin esperar ese tiempo, se perderían las
            // primeras líneas de telemetría (o se leería basura del bootloader).
            try {
                await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
            } catch (e) {
                console.warn('[PlayBoard] Error enviando señales de reset:', e.message);
            }
            // Esperar a que el bootloader termine y el sketch arranque.
            await new Promise(resolve => setTimeout(resolve, 1200));

            console.log('[PlayBoard] Conectado');

            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            this.readableStreamClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('[PlayBoard] Dispositivo desconectado físicamente (readable)');
                    this._handleUnexpectedDisconnect();
                }
            });

            const textEncoder = new TextEncoderStream();
            this.writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            this.writableStreamClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('[PlayBoard] Dispositivo desconectado físicamente (writable)');
                    this._handleUnexpectedDisconnect();
                }
            });

            this.readLoop();

        } catch (err) {
            console.error('[PlayBoard] Error al conectar:', err);
            this.connected = false;
            this.port = null;
            throw err;
        }
    }

    _handleUnexpectedDisconnect() {
        if (!this.connected) return;

        this.connected = false;
        this.keepReading = false;

        this._cleanupBeforeReconnect().catch(() => {});

        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    async disconnect() {
        this.keepReading = false;
        await this._cleanupBeforeReconnect();
        this.connected = false;
        console.log('[PlayBoard] Puerto desconectado');
    }

    async _cleanupBeforeReconnect() {
        try {
            if (this.writer) {
                await this.writer.close().catch(e => {
                    if (e && e.message && !e.message.includes('device has been lost')) {
                        console.warn('Error cerrando writer:', e.message);
                    }
                });
                this.writer = null;
            }

            if (this.reader) {
                try {
                    await this.reader.cancel().catch(e => { });
                } catch (e) { }
                this.reader = null;
            }

            const pipeWaits = [];
            if (this.readableStreamClosed) {
                pipeWaits.push(this.readableStreamClosed.catch(() => { }));
            }
            if (this.writableStreamClosed) {
                pipeWaits.push(this.writableStreamClosed.catch(() => { }));
            }
            if (pipeWaits.length > 0) {
                await Promise.all(pipeWaits);
            }
            this.readableStreamClosed = null;
            this.writableStreamClosed = null;

            if (this.port) {
                try {
                    await this.port.close();
                } catch (e) {
                    if (e && e.name !== 'InvalidStateError' && !e.message.includes('already closed')) {
                        console.warn('⚠️ Error al cerrar puerto:', e.message);
                    }
                }
                this.port = null;
            }

            this.buffer = '';

        } catch (err) {
            if (err && err.message && !err.message.includes('device has been lost')) {
                console.error('Error en cleanup:', err);
            }
        }
    }

    async readLoop() {
        try {
            while (this.keepReading && this.reader) {
                const { value, done } = await this.reader.read();

                if (done) break;

                if (value) this.handleIncoming(value);
            }
        } catch (err) {
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('[PlayBoard] Dispositivo desconectado físicamente (readLoop)');
                this._handleUnexpectedDisconnect();
                return;
            }

            if (err && err.name === 'AbortError' && !this.keepReading) return;

            if (this.keepReading && err) {
                console.error('[PlayBoard] Error en readLoop:', err.message || err);
            }
        }
    }

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
                        console.warn('[PlayBoard] JSON inválido:', line.substring(0, 60));
                    }
                }
            }
        }

        if (this.buffer.length > 1024) {
            console.warn('[PlayBoard] Buffer muy grande, limpiando');
            const lastBrace = this.buffer.lastIndexOf('{');
            this.buffer = lastBrace !== -1 ? this.buffer.substring(lastBrace) : '';
        }
    }

    async write(msg) {
        if (!this.writer) {
            console.error('[PlayBoard] No hay conexión activa');
            return;
        }

        try {
            await this.writer.write(msg + '\n');
            console.log('[PlayBoard] TX:', msg);
        } catch (err) {
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('[PlayBoard] Dispositivo desconectado durante escritura');
                this._handleUnexpectedDisconnect();
                return;
            }
            console.error('[PlayBoard] Error enviando datos:', err);
            throw err;
        }
    }

    isPortOpen() {
        return this.port && this.connected && this.port.readable && this.port.writable;
    }
}

module.exports = PlayBoardSerial;
