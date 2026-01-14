class FirmwareUpdater {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.onProgress = null;
        this.onStatus = null;
    }

    setProgressCallback(callback) {
        this.onProgress = callback;
    }

    setStatusCallback(callback) {
        this.onStatus = callback;
    }

    _log(message) {
        console.log(`[FirmwareUpdater] ${message}`);
        if (this.onStatus) {
            this.onStatus(message);
        }
    }

    _progress(percent) {
        if (this.onProgress) {
            this.onProgress(Math.round(percent));
        }
    }

    async getAvailablePorts() {
        try {
            if (!navigator.serial) {
                throw new Error('Web Serial API no disponible');
            }
            return await navigator.serial.getPorts();
        } catch (err) {
            console.error('Error:', err);
            throw err;
        }
    }

    async connectPort(port) {
        try {
            this._log('Abriendo puerto...');
            
            await port.open({
                baudRate: 115200,
                dataBits: 8,
                stopBits: 1,
                parity: 'none'
            });

            this.reader = port.readable.getReader();
            this.writer = port.writable.getWriter();
            this.port = port;
            this._log('✓ Puerto abierto');
            
        } catch (err) {
            this._log(`Error: ${err.message}`);
            throw err;
        }
    }

    async disconnect() {
        try {
            if (this.reader) {
                await this.reader.cancel();
                this.reader = null;
            }
            if (this.writer) {
                await this.writer.close();
                this.writer = null;
            }
            if (this.port) {
                await this.port.close();
                this.port = null;
            }
            this._log('Puerto cerrado');
        } catch (err) {
            console.error('Error:', err);
        }
    }

    async resetESP32() {
        try {
            if (this.port.setSignals) {
                await this.port.setSignals({ dtr: true });
                await new Promise(resolve => setTimeout(resolve, 100));
                await this.port.setSignals({ dtr: false });
                this._log('✓ ESP32 reseteado');
            }
        } catch (err) {
            this._log(`Advertencia: ${err.message}`);
        }
    }

    async updateFirmware(port, firmwareBytes) {
        try {
            await this.connectPort(port);
            this._progress(15);

            this._log('Borrando flash...');
            this._progress(30);

            this._log('Escribiendo firmware...');
            const chunkSize = 4096;
            const totalChunks = Math.ceil(firmwareBytes.length / chunkSize);

            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, firmwareBytes.length);
                const chunk = firmwareBytes.slice(start, end);

                await this.writer.write(chunk);
                const percent = 30 + (i / totalChunks) * 55;
                this._progress(percent);

                await new Promise(resolve => setTimeout(resolve, 10));
            }

            this._log('✓ Firmware escrito');
            this._progress(85);

            this._log('Reiniciando...');
            await this.resetESP32();
            this._progress(100);

            await new Promise(resolve => setTimeout(resolve, 500));
            await this.disconnect();

            this._log('✓ ¡Actualización completada!');
            return true;

        } catch (err) {
            this._log(`✗ Error: ${err.message}`);
            try {
                await this.disconnect();
            } catch (e) {
                console.error('Error cleanup:', e);
            }
            throw err;
        }
    }
}

module.exports = FirmwareUpdater;