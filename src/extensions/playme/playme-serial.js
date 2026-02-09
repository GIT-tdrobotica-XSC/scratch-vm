class PlayMeSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
        this.readableStreamClosed = null;
    }

    async connect(port) {
        if (!port) {
            console.error('No se proporcionó puerto');
            return;
        }

        await this._cleanupBeforeReconnect();

        this.port = port;

        try {
            if (this.port.readable === null || this.port.writable === null) {
                await this.port.open({ baudRate: 115200 });
            }

            this.keepReading = true;
            this.connected = true;
            this.buffer = '';

            // 🔌 Hardware Reset: Forzar rampa DTR/RTS para asegurar salida de modo bootloader
            try {
                await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (e) {
                console.warn('⚠️ Error enviando señales de reset:', e.message);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log('Conectado al PlayMe');

            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            this.readableStreamClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('Dispositivo desconectado');
                    this._handleUnexpectedDisconnect();
                }
            });

            const textEncoder = new TextEncoderStream();
            const writableClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            writableClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('Dispositivo desconectado durante escritura');
                    this._handleUnexpectedDisconnect();
                }
            });

            this.readLoop();

        } catch (err) {
            console.error('Error al conectar:', err);
            this.connected = false;
            this.port = null;
            throw err;
        }
    }

    _handleUnexpectedDisconnect() {
        if (!this.connected) return;

        this.connected = false;
        this.keepReading = false;

        if (this.onDisconnect) {
            this.onDisconnect();
        }
    }

    async disconnect() {
        this.keepReading = false;
        await this._cleanupBeforeReconnect();
        this.connected = false;
        console.log('Puerto desconectado');
    }

    /**
     * 🔓 Libera los streams (reader/writer) pero mantiene el objeto port abierto.
     */
    async releasePort() {
        console.log('🔓 Liberando puerto para actualización de firmware...');
        this.keepReading = false;

        if (this.writer) {
            try { await this.writer.close(); } catch (e) { }
            this.writer = null;
        }

        if (this.reader) {
            try { await this.reader.cancel(); } catch (e) { }
            this.reader = null;
        }

        if (this.readableStreamClosed) {
            try { await this.readableStreamClosed.catch(() => { }); } catch (e) { }
            this.readableStreamClosed = null;
        }

        if (this.port) {
            try { await this.port.close(); } catch (e) { }
        }

        this.connected = false;
        console.log('✅ Puerto cerrado y listo para esptool-js.');
    }

    /**
     * 🔐 Retoma un puerto que ya está abierto y re-inicializa los streams.
     */
    async claimPort(port) {
        if (!port) return;
        console.log('🔐 Reclamando puerto post-flasheo (PlayMe)...');
        try {
            await this.connect(port);
            console.log('✅ Puerto reclamado exitosamente.');
        } catch (err) {
            console.error('❌ Error al reclamar puerto:', err);
            this.connected = false;
        }
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

            if (this.readableStreamClosed) {
                await this.readableStreamClosed.catch(() => { });
                this.readableStreamClosed = null;
            }

            await new Promise(resolve => setTimeout(resolve, 100));

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

                if (done) {
                    break;
                }

                if (value) {
                    this.handleIncoming(value);
                }
            }
        } catch (err) {
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('Dispositivo desconectado');
                this._handleUnexpectedDisconnect();
                return;
            }

            if (err && err.name === 'AbortError' && !this.keepReading) {
                return;
            }

            if (this.keepReading && err) {
                console.error('Error en readLoop:', err.message || err);
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
                    console.log('RX:', data);

                    if (this.onData) {
                        this.onData(data);
                    }
                } catch (err) {
                    if (line.includes('"inputs"') || line.includes('"ok"')) {
                        console.warn('JSON inválido:', line.substring(0, 60));
                    }
                }
            }
        }

        if (this.buffer.length > 1024) {
            console.warn('Buffer muy grande, limpiando');
            const lastBrace = this.buffer.lastIndexOf('{');
            if (lastBrace !== -1) {
                this.buffer = this.buffer.substring(lastBrace);
            } else {
                this.buffer = '';
            }
        }
    }

    async write(msg) {
        if (!this.writer) {
            console.error('No hay conexión activa');
            return;
        }

        try {
            await this.writer.write(msg + '\n');
            console.log('TX:', msg);
        } catch (err) {
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('Dispositivo desconectado durante escritura');
                this._handleUnexpectedDisconnect();
                return;
            }

            console.error('Error enviando datos:', err);
            throw err;
        }
    }

    isPortOpen() {
        return this.port && this.connected && this.port.readable && this.port.writable;
    }
}

module.exports = PlayMeSerial;