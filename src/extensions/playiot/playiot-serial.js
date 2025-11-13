class PlayIotSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
    }

    // Conecta al puerto recibido
    async connect(port) {
        if (!port) {
            console.error('❌ No se proporcionó puerto');
            return;
        }

        // Cierra puerto previo si existía
        if (this.port && this.connected) {
            await this.disconnect();
        }

        this.port = port;

        try {
            if (!this.port.readable || !this.port.writable) {
                await this.port.open({ baudRate: 115200 });
            }

            this.keepReading = true;
            this.connected = true;
            console.log('✅ Conectado al ESP32');

            // Iniciar lectura
            this.readLoop();

            // Configurar escritura
            const textEncoder = new TextEncoderStream();
            textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();
        } catch (err) {
            console.error('❌ Error al conectar:', err);
            this.connected = false;
            this.port = null;
            throw err;
        }
    }

    async disconnect() {
        this.keepReading = false;

        try {
            if (this.writer) {
                // Ensure writer is closed
                await this.writer.close().catch(e => console.warn('Error cerrando writer:', e));
                this.writer = null;
            }

            if (this.reader) {
                // Cancelling the reader causes the readLoop() to throw an AbortError, 
                // which is now handled inside readLoop().
                await this.reader.cancel().catch(e => console.warn('Error cancelando reader:', e));
                this.reader = null;
            }

            if (this.port) {
                await this.port.close().catch(e => console.warn('Error cerrando puerto:', e));
                this.port = null;
            }

            this.connected = false;
            console.log('🔌 Puerto desconectado');
        } catch (err) {
            console.error('❌ Error al desconectar:', err);
        }
    }

    async readLoop() {
        try {
            const textDecoder = new TextDecoderStream();
            this.port.readable.pipeTo(textDecoder.writable);
            this.reader = textDecoder.readable.getReader();

            while (this.keepReading) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) this.handleIncoming(value);
            }

            await this.reader.releaseLock();
        } catch (err) {
            // FIX: Explicitly check for AbortError, which is the expected error when the reader is canceled 
            // during disconnection. If this is the case, we exit silently to prevent an unhandled rejection.
            if (err.name === 'AbortError' && !this.keepReading) {
                console.log('ℹ️ Read loop cancelado (AbortError) por desconexión');
                // We return here to resolve the readLoop promise silently.
                return;
            }
            console.error('❌ Error en readLoop:', err);
            this.keepReading = false;
        }
    }

    // 📌 Maneja buffer por líneas, evita JSON incompleto
    handleIncoming(text) {
        this.buffer += text;
        let lines = this.buffer.split('\n'); // separa por salto de línea
        this.buffer = lines.pop(); // deja última línea incompleta en buffer

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            try {
                const data = JSON.parse(line);
                console.log('📥 RX:', data);
            } catch (err) {
                console.warn('⚠️ JSON inválido:', line, err);
            }
        }
    }

    async write(msg) {
        if (!this.writer) {
            console.error('❌ No hay conexión activa para escribir');
            return;
        }

        try {
            await this.writer.write(msg + '\n'); // agrega salto de línea
            console.log('📤 TX:', msg);
        } catch (err) {
            console.error('❌ Error enviando datos:', err);
            throw err;
        }
    }

    isPortOpen() {
        return this.port && this.connected && this.port.readable && this.port.writable;
    }
}

module.exports = PlayIotSerial;