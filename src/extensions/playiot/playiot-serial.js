class PlayIotSerial {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.keepReading = false;
        this.buffer = ''; // acumula los fragmentos de JSON
    }

    async connect() {
        try {
            // Solicita el puerto
            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate: 115200 });
            console.log('✅ PlayIoT: conectado al ESP32');

            this.keepReading = true;
            this.readLoop();

            const textEncoder = new TextEncoderStream();
            const writableStreamClosed = textEncoder.readable.pipeTo(this.port.writable);
            this.writer = textEncoder.writable.getWriter();

        } catch (e) {
            console.error('❌ Error al conectar PlayIoT:', e);
        }
    }

    async readLoop() {
        try {
            const textDecoder = new TextDecoderStream();
            const readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
            const reader = textDecoder.readable.getReader();
            console.log('PlayIotSerial: leyendo datos...');

            while (this.keepReading) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    this.handleIncoming(value);
                }
            }

            reader.releaseLock();
        } catch (e) {
            console.error('Error en readLoop:', e);
        }
    }

    handleIncoming(text) {
        this.buffer += text;

        // Procesa JSON completo (si llega un "}")
        while (this.buffer.includes('}')) {
            const start = this.buffer.indexOf('{');
            const end = this.buffer.indexOf('}') + 1;
            if (start < 0 || end <= start) break;

            const jsonStr = this.buffer.substring(start, end);
            this.buffer = this.buffer.substring(end); // limpia lo ya procesado

            try {
                const data = JSON.parse(jsonStr);
                console.log('PlayIotSerial RX:', data);
            } catch (err) {
                console.warn('PlayIotSerial JSON inválido:', jsonStr, err);
            }
        }
    }

    async write(msg) {
        if (!this.writer) {
            console.error('PlayIotSerial: no hay conexión activa');
            return;
        }

        try {
            await this.writer.write(msg + '\n');
            console.log('PlayIotSerial TX:', msg);
        } catch (e) {
            console.error('Error al enviar datos:', e);
        }
    }

    async disconnect() {
        this.keepReading = false;
        if (this.reader) {
            await this.reader.cancel();
            this.reader.releaseLock();
        }
        if (this.writer) {
            await this.writer.close();
        }
        if (this.port) {
            await this.port.close();
        }
        console.log('🔌 PlayIoT: desconectado');
    }
}

module.exports = PlayIotSerial;
