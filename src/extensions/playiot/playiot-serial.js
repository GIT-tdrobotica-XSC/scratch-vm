class PlayIotSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
        this.readableStreamClosed = null;
        this._lastRxTime = null;
    }

    async connect(port) {
        if (!port) {
            console.error('❌ No se proporcionó puerto');
            return;
        }

        // 🔄 Limpia cualquier conexión anterior antes de abrir una nueva
        await this._cleanupBeforeReconnect();

        this.port = port;

        try {
            if (this.port.readable === null || this.port.writable === null) {
                await this.port.open({ baudRate: 115200 });
            }

            this.keepReading = true;
            this.connected = true;
            this.buffer = ''; // 🧹 limpia buffer viejo

            // 🔌 Hardware Reset: Forzar rampa DTR/RTS para asegurar salida de modo bootloader
            try {
                await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (e) {
                console.warn('⚠️ Error enviando señales de reset:', e.message);
            }

            // 🔴 NUEVO: Esperar un poco para que se estabilice después del reset
            await new Promise(resolve => setTimeout(resolve, 1000));

            console.log('✅ Conectado al ESP32');

            // Configurar decodificador
            const textDecoder = new TextDecoderStream();
            this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            // ✨ Capturar errores del pipe
            this.readableStreamClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('🔌 Dispositivo desconectado físicamente (pipe)');
                    this._handleUnexpectedDisconnect();
                }
            });

            // Configurar escritura
            const textEncoder = new TextEncoderStream();
            const writableClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

            // ✨ Capturar errores del writable pipe
            writableClosed.catch(err => {
                if (err && err.message && err.message.includes('device has been lost')) {
                    console.log('🔌 Dispositivo desconectado físicamente (writable)');
                    this._handleUnexpectedDisconnect();
                }
            });

            // Iniciar lectura
            this.readLoop();

        } catch (err) {
            console.error('❌ Error al conectar:', err);
            this.connected = false;
            this.port = null;
            throw err;
        }
    }

    // ✨ NUEVO: Manejar desconexión inesperada
    _handleUnexpectedDisconnect() {
        if (!this.connected) return; // Ya se manejó

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
        console.log('🔌 Puerto desconectado correctamente');
    }

    /**
     * 🔓 Libera los streams (reader/writer) pero mantiene el objeto port abierto.
     * Útil para ceder el control a esptool-js sin perder el permiso del puerto.
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
            // Mantenemos la referencia this.port para que el modal la use,
            // pero el puerto está físicamente cerrado para que esptool-js lo abra.
        }

        this.connected = false;
        console.log('✅ Puerto cerrado y listo para esptool-js.');
    }

    /**
     * 🔐 Retoma un puerto que ya está abierto y re-inicializa los streams.
     */
    async claimPort(port) {
        if (!port) return;
        console.log('🔐 Reclamando puerto post-flasheo...');
        try {
            // Usamos el método connect oficial que ya tiene toda la lógica de robustez
            await this.connect(port);
            console.log('✅ Puerto reclamado exitosamente.');
        } catch (err) {
            console.error('❌ Error al reclamar puerto:', err);
            this.connected = false;
        }
    }

    // 🧩 Método interno: limpia todo para evitar bucles viejos y streams bloqueados
    async _cleanupBeforeReconnect() {
        try {
            if (this.writer) {
                await this.writer.close().catch(e => {
                    // Ignorar si el dispositivo ya se perdió o no hay error
                    if (e && e.message && !e.message.includes('device has been lost')) {
                        console.warn('⚠️ Error cerrando writer:', e.message);
                    }
                });
                this.writer = null;
            }

            if (this.reader) {
                try {
                    await this.reader.cancel().catch(e => {
                        // Ignorar errores silenciosamente
                    });
                } catch (e) {
                    // Ignorar
                }
                this.reader = null;
            }

            if (this.readableStreamClosed) {
                await this.readableStreamClosed.catch(() => { });
                this.readableStreamClosed = null;
            }

            // ⏱️ Pequeña pausa para liberar streams
            await new Promise(resolve => setTimeout(resolve, 100));

            if (this.port) {
                try {
                    await this.port.close();
                } catch (e) {
                    // Silenciamos "already closed" ya que es esperado si esptool-js lo cerró
                    if (e && e.name !== 'InvalidStateError' && !e.message.includes('already closed')) {
                        console.warn('⚠️ Error al cerrar puerto:', e.message);
                    }
                }
                this.port = null;
            }

            // 💡 Reset total del buffer
            this.buffer = '';

        } catch (err) {
            // Ignorar errores de dispositivo perdido o errores vacíos
            if (err && err.message && !err.message.includes('device has been lost')) {
                console.error('❌ Error en cleanup:', err);
            }
        }
    }

    async readLoop() {
        try {
            while (this.keepReading && this.reader) {
                const { value, done } = await this.reader.read();

                if (done) {
                    console.log('ℹ️ Stream terminado');
                    break;
                }

                if (value) {
                    this.handleIncoming(value);
                }
            }
        } catch (err) {
            // ✨ Capturar desconexión física del dispositivo
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('🔌 Dispositivo desconectado físicamente (readLoop)');
                this._handleUnexpectedDisconnect();
                return;
            }

            // Desconexión intencional
            if (err && err.name === 'AbortError' && !this.keepReading) {
                console.log('ℹ️ Lectura cancelada por desconexión');
                return;
            }

            // Otros errores solo si está activo
            if (this.keepReading && err) {
                console.error('❌ Error en readLoop:', err.message || err);
            }
        }
    }

    handleIncoming(text) {
        this.buffer += text;

        // Procesar línea por línea
        const lines = this.buffer.split('\n');

        // Guardar la última línea (puede estar incompleta)
        this.buffer = lines.pop() || '';

        for (let line of lines) {
            line = line.trim();

            // Ignorar líneas vacías
            if (!line) continue;

            // Solo procesar si parece un JSON (empieza con { y termina con })
            if (line.startsWith('{') && line.endsWith('}')) {
                try {
                    const data = JSON.parse(line);
                    console.log('📥 RX:', data);
                    this._lastRxTime = Date.now();

                    // Si hay un handler externo (para sensores), llamarlo
                    if (this.onData) {
                        this.onData(data);
                    }
                } catch (err) {
                    // Solo mostrar error si la línea parece ser JSON
                    if (line.includes('"inputs"') || line.includes('"ok"')) {
                        console.warn('⚠️ JSON inválido:', line.substring(0, 60));
                    }
                }
            }
        }

        // Limpiar buffer si crece mucho
        if (this.buffer.length > 1024) {
            console.warn('⚠️ Buffer muy grande, limpiando');
            // Intentar mantener solo desde el último '{'
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
            console.error('❌ No hay conexión activa para escribir');
            return;
        }

        try {
            await this.writer.write(msg + '\n');
            console.log('📤 TX:', msg);
        } catch (err) {
            // ✨ Capturar desconexión durante escritura
            if (err && err.message && err.message.includes('device has been lost')) {
                console.log('🔌 Dispositivo desconectado durante escritura');
                this._handleUnexpectedDisconnect();
                return;
            }

            console.error('❌ Error enviando datos:', err);
            throw err;
        }
    }

    isPortOpen() {
        return this.port && this.connected && this.port.readable && this.port.writable;
    }
}

module.exports = PlayIotSerial;