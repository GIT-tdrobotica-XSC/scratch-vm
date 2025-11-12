class PlayIotSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.connected = false;
        this.buffer = '';
    }

    async scan() {
        try {
            this.port = await navigator.serial.requestPort();
            console.log('✅ Puerto seleccionado');
        } catch (err) {
            console.error('❌ No se seleccionó puerto:', err);
        }
    }

    async connect() {
        if (!this.port) {
            console.error('❌ No hay puerto seleccionado');
            return;
        }
        try {
            await this.port.open({ baudRate: 115200 });
            this.keepReading = true;
            this.connected = true;
            console.log('✅ Conectado al ESP32');
            this.readLoop();

            const textEncoder = new TextEncoderStream();
            textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();
        } catch (err) {
            console.error('❌ Error al conectar:', err);
            this.connected = false;
        }
    }

    async disconnect() {
        this.keepReading = false;
        if (this.writer) {
            await this.writer.close();
            this.writer = null;
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
            this.connected = false;
            console.log('🔌 Puerto desconectado');
        }
    }

    async readLoop() {
        const textDecoder = new TextDecoderStream();
        this.port.readable.pipeTo(textDecoder.writable);
        const reader = textDecoder.readable.getReader();

        while (this.keepReading) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) this.handleIncoming(value);
        }

        reader.releaseLock();
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
                console.log('RX:', data);
            } catch (err) {
                console.warn('JSON inválido:', jsonStr);
            }
        }
    }

    async write(msg) {
        if (!this.writer) {
            console.error('❌ No hay conexión activa');
            return;
        }
        try {
            await this.writer.write(msg + '\n');
            console.log('TX:', msg);
        } catch (err) {
            console.error('Error enviando datos:', err);
        }
    }
}

module.exports = PlayIotSerial;
