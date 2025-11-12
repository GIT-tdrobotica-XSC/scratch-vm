class PlayIotSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
    }

    // ✨ MODIFICADO: Ahora acepta el puerto como parámetro
    async connect(port) {
        if (!port) {
            console.error('❌ No se proporcionó puerto');
            return;
        }

        // Si ya hay un puerto abierto, cerrarlo primero
        if (this.port && this.connected) {
            await this.disconnect();
        }

        this.port = port;

        try {
            // Verificar si el puerto ya está abierto
            if (!this.port.readable || !this.port.writable) {
                await this.port.open({ baudRate: 115200 });
            }
            
            this.keepReading = true;
            this.connected = true;
            console.log('✅ Conectado al ESP32');
            
            // Iniciar lectura en segundo plano
            this.readLoop();

            // Configurar escritura
            const textEncoder = new TextEncoderStream();
            textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

        } catch (err) {
            console.error('❌ Error al conectar:', err);
            this.connected = false;
            this.port = null;
            throw err; // Propagar el error para manejarlo arriba
        }
    }

    async disconnect() {
        this.keepReading = false;
        
        try {
            if (this.writer) {
                await this.writer.close().catch(e => console.warn('Error cerrando writer:', e));
                this.writer = null;
            }
            
            if (this.reader) {
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
            console.error('❌ Error en readLoop:', err);
            this.keepReading = false;
        }
    }

    handleIncoming(text) {
        this.buffer += text;
        while (this.buffer.includes('}')) {
            const start = this.buffer.indexOf('{');
            const end = this.buffer.indexOf('}') + 1;
            if (start < 0 || end <= start) break;

            const jsonStr = this.buffer.substring(start, end);
            this.buffer = this.buffer.substring(end);

            try {
                const data = JSON.parse(jsonStr);
                console.log('📥 RX:', data);
            } catch (err) {
                console.warn('⚠️ JSON inválido:', jsonStr);
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
            console.error('❌ Error enviando datos:', err);
            throw err;
        }
    }

    // ✨ NUEVO: Método útil para verificar si el puerto está disponible
    isPortOpen() {
        return this.port && this.connected && this.port.readable && this.port.writable;
    }
}

module.exports = PlayIotSerial;