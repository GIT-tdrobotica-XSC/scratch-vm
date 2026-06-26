const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');

const blockIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB4PSI2IiB5PSIxMCIgd2lkdGg9IjI4IiBoZWlnaHQ9IjIwIiByeD0iMyIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSIjMDA5Njg4IiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSI1IiBmaWxsPSIjMDA5Njg4Ii8+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMiIgZmlsbD0iI2ZmZiIvPjxyZWN0IHg9IjE1IiB5PSI2IiB3aWR0aD0iMTAiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiMwMDk2ODgiLz48L3N2Zz4=';
const menuIconURI = blockIconURI;

const STORAGE_KEY = 'playcode_ml_models';
const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js';
const MOBILENET_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.0/dist/mobilenet.min.js';
const KNN_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1.2.4/dist/knn-classifier.min.js';
const POSE_DETECTION_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.0/dist/pose-detection.min.js';
// Audio: tfjs 1.5.2 + speech-commands 0.4.2 (que requiere tfjs ^1.5.2; stack 1.x de
// Google TM; evita el error de shader de speech-commands con tfjs 3.x). Coexiste con
// tfjs 3.x vía this._tf.
const TFJS_AUDIO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.5.2/dist/tf.min.js';
const SPEECH_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.4.2/dist/speech-commands.min.js';
const PREDICT_INTERVAL = 200;
const POSE_MIN_SCORE = 0.2;

class Scratch3TeachableMachine {
    constructor (runtime) {
        this.runtime = runtime;

        // Exponer runtime para que el ML Studio pueda emitir eventos
        window.__scratchVMRuntime = runtime;

        // Estado de librerías
        this._libReady = false;

        // Modelo KNN
        this._classifier = null;
        this._tf = null;       // referencia a tfjs 3.x (imagen/pose)
        this._mobilenet = null;
        this._detector = null; // MoveNet (pose-detection)
        this._modelType = 'image'; // 'image' | 'pose' | 'audio'
        this._lastPoseVec = null;  // último vector de keypoints (modo pose)
        this._modelName = null;
        this._loadedOk = false; // true cuando un modelo terminó de cargar (para caché)
        this._classMap = {}; // { '0': 'Mano abierta', '1': 'Puño', ... }
        this._classLabels = []; // nombres en orden

        // Audio (speech-commands)
        this._baseRecognizer = null;
        this._audioRecognizer = null;
        this._audioListening = false;
        this._audioLabelToName = {};

        // Predicciones
        this._topClass = '';
        this._topProbability = 0;
        this._allConfidences = {}; // { className: probability }

        // Precisión: suavizado temporal y parámetro k del KNN
        this._smoothingWindow = 10;     // frames a promediar
        this._confidenceBuffer = [];    // historial de vectores de confianza por índice
        this._knnK = 3;                 // se ajusta al cargar el modelo según nº de muestras
        this._classifyInterval = PREDICT_INTERVAL;

        // Cámara propia (video oculto)
        this._videoEl = null;
        this._cameraStream = null;
        this._cameraOn = false;
        this._isPredicting = false;
        this._predictTimer = null;
        this._videoFlipped = true;      // espejo por defecto (coincide con el entrenamiento)

        // Escuchar modelos actualizados desde ML Studio
        runtime.on('ML_MODELS_UPDATED', () => {
            // Invalidar el caché: un modelo pudo re-guardarse con el mismo nombre
            this._loadedOk = false;
            if (runtime.requestToolboxExtensionsUpdate) {
                runtime.requestToolboxExtensionsUpdate();
            }
        });

        if (runtime) {
            runtime.on('PROJECT_STOP_ALL', () => {
                this._topClass = '';
                this._topProbability = 0;
                this._allConfidences = {};
            });
        }
    }

    // ── CDN loader ────────────────────────────────────────────────────────────

    _injectScript (src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing && existing.getAttribute('data-loaded') === 'true') return resolve();
            if (existing) {
                existing.addEventListener('load', resolve);
                existing.addEventListener('error', reject);
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => { s.setAttribute('data-loaded', 'true'); resolve(); };
            s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
            document.head.appendChild(s);
        });
    }

    // Carga las librerías necesarias según el tipo de modelo.
    // image → MobileNet · pose → PoseNet · audio → SpeechCommands. TF.js siempre.
    async _loadLibrary (type) {
        if (type === 'audio') {
            // Stack de Google TM: tfjs 1.3.1 + speech-commands 0.4.0 (sin shader error)
            await this._injectScript(TFJS_AUDIO_URL);
            window.__tmTf1 = window.__tmTf1 || window.tf;
            await this._injectScript(SPEECH_URL);
            if (!this._baseRecognizer) {
                this._baseRecognizer = window.speechCommands.create('BROWSER_FFT');
                await this._baseRecognizer.ensureModelLoaded();
            }
            this._libReady = true;
            return;
        }

        // Imagen/pose: tfjs 3.x (capturar la referencia estable)
        await this._injectScript(TFJS_URL);
        window.__tmTf3 = window.__tmTf3 || window.tf;
        this._tf = window.__tmTf3;

        await this._injectScript(KNN_URL);
        if (type === 'pose') {
            await this._injectScript(POSE_DETECTION_URL);
            if (this._tf && this._tf.ready) await this._tf.ready();
            if (!this._detector) {
                this._detector = await window.poseDetection.createDetector(
                    window.poseDetection.SupportedModels.MoveNet,
                    {modelType: window.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING}
                );
            }
        } else {
            await this._injectScript(MOBILENET_URL);
            if (!this._mobilenet) {
                this._mobilenet = await window.mobilenet.load();
            }
        }
        this._libReady = true;
    }

    // Convierte una pose de PoseNet en un vector normalizado (invariante a
    // traslación y escala). Debe coincidir con el de ML Studio para que los
    // modelos guardados sean compatibles.
    // MoveNet: keypoints con {x, y, score, name}
    _poseToVector (pose) {
        if (!pose || !pose.keypoints) return null;
        const kp = pose.keypoints;
        const valid = kp.filter(k => (k.score || 0) >= POSE_MIN_SCORE);
        if (valid.length < 5) return null;
        const xs = kp.map(k => k.x);
        const ys = kp.map(k => k.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = (maxX - minX) || 1;
        const h = (maxY - minY) || 1;
        const vec = [];
        for (const k of kp) {
            vec.push((k.x - minX) / w);
            vec.push((k.y - minY) / h);
        }
        return vec; // 34 dims (17 keypoints × 2)
    }

    // ── Camera (hidden video element) ─────────────────────────────────────────

    _ensureVideoElement () {
        if (this._videoEl) return;
        const v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.muted = true;
        v.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:224px;height:224px;pointer-events:none;';
        document.body.appendChild(v);
        this._videoEl = v;
    }

    async _enableCamera () {
        this._ensureVideoElement();
        if (this._cameraOn && this._cameraStream) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {width: 224, height: 224, facingMode: 'user'}
            });
            this._cameraStream = stream;
            this._videoEl.srcObject = stream;
            await this._videoEl.play();
            this._cameraOn = true;
            // Notificar GUI para mostrar widget de cámara
            if (this.runtime) this.runtime.emit('TM_CAMERA_STARTED', stream);
        } catch (err) {
            console.error('[TM] No se pudo acceder a la cámara:', err);
        }
    }

    _disableCamera () {
        clearInterval(this._predictTimer);
        this._predictTimer = null;
        this._cameraOn = false;
        if (this._cameraStream) {
            this._cameraStream.getTracks().forEach(t => t.stop());
            this._cameraStream = null;
        }
        if (this.runtime) this.runtime.emit('TM_CAMERA_STOPPED');
    }

    // ── Predict loop ──────────────────────────────────────────────────────────

    _startPredictLoop () {
        clearInterval(this._predictTimer);
        this._confidenceBuffer = [];
        this._predictTimer = setInterval(async () => {
            if (!this._cameraOn || !this._classifier) return;
            const extractor = this._modelType === 'pose' ? this._detector : this._mobilenet;
            if (!extractor) return;
            if (!this._videoEl || this._videoEl.readyState < 2) return;
            if (this._isPredicting) return;
            if (this._classifier.getNumClasses() < 2) return;

            this._isPredicting = true;
            try {
                let features;
                if (this._modelType === 'pose') {
                    const poses = await this._detector.estimatePoses(
                        this._videoEl, {flipHorizontal: false}
                    );
                    const vec = this._poseToVector(poses && poses[0]);
                    if (!vec) { this._isPredicting = false; return; }
                    features = this._tf.tensor1d(vec);
                } else {
                    features = this._mobilenet.infer(this._videoEl, true);
                }
                const result = await this._classifier.predictClass(features, this._knnK);
                features.dispose();

                // ── Suavizado temporal: promediar las últimas N predicciones ──
                this._confidenceBuffer.push(result.confidences);
                if (this._confidenceBuffer.length > this._smoothingWindow) {
                    this._confidenceBuffer.shift();
                }
                const smoothed = {};
                for (const buf of this._confidenceBuffer) {
                    for (const k in buf) {
                        smoothed[k] = (smoothed[k] || 0) + buf[k];
                    }
                }
                let topIdx = null;
                let topProb = -1;
                for (const k in smoothed) {
                    smoothed[k] /= this._confidenceBuffer.length;
                    if (smoothed[k] > topProb) {
                        topProb = smoothed[k];
                        topIdx = k;
                    }
                }

                this._topClass = this._classMap[topIdx] || topIdx;
                this._topProbability = topProb;

                // Mapear confianzas suavizadas con nombres de clases
                const named = {};
                for (const k in smoothed) {
                    const name = this._classMap[k] || k;
                    named[name] = smoothed[k];
                }
                this._allConfidences = named;
            } catch (e) { /* ignore */ }
            this._isPredicting = false;
        }, this._classifyInterval);
    }

    // ── Load saved model ──────────────────────────────────────────────────────

    _getStoredModels () {
        try {
            const w = window.playcodeMLModels;
            if (w) return w;
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    async loadModel (args) {
        const name = String(args.MODEL_NAME || '').trim();
        if (!name) return;

        // Caché: si ya está cargado este mismo modelo, no recargar (evita que la
        // bandera verde se quede pegada al hacer click varias veces).
        if (this._modelName === name && this._loadedOk) return;
        this._loadedOk = false;

        const models = this._getStoredModels();
        const model = models[name];
        if (!model) {
            console.warn(`[TM] Modelo "${name}" no encontrado en ML Studio`);
            return;
        }

        // Detectar tipo (image/pose/audio) y cargar la librería correcta
        this._modelType = model.type || 'image';
        await this._loadLibrary(this._modelType);

        // Audio usa speech-commands (transfer learning), no KNN
        if (this._modelType === 'audio') {
            return this._loadAudioModel(model, name);
        }

        // Reconstruir KNN classifier desde el dataset guardado
        this._classifier = window.knnClassifier.create();
        const dataset = {};
        let minSamples = Infinity;
        for (const label in model.dataset) {
            const {data, shape} = model.dataset[label];
            dataset[label] = this._tf.tensor2d(data, shape);
            minSamples = Math.min(minSamples, shape[0]);
        }
        this._classifier.setClassifierDataset(dataset);

        // Ajustar k del KNN: ~mitad de las muestras de la clase más pequeña,
        // acotado entre 3 y 10. Mejora la robustez sin sobre-suavizar.
        if (!isFinite(minSamples)) minSamples = 3;
        this._knnK = Math.max(3, Math.min(10, Math.floor(minSamples / 2) || 3));

        // Mapear índices → nombres de clase
        this._classMap = {};
        this._classLabels = [];
        for (const cls of model.classes) {
            this._classMap[cls.index] = cls.name;
            this._classLabels.push(cls.name);
        }

        this._modelName = name;
        this._topClass = '';
        this._topProbability = 0;
        this._allConfidences = {};

        console.log(`[TM] Modelo "${name}" cargado. Clases:`, this._classLabels);

        if (this.runtime && this.runtime.requestToolboxExtensionsUpdate) {
            this.runtime.requestToolboxExtensionsUpdate();
        }

        // Encender cámara automáticamente
        await this._enableCamera();
        this._startPredictLoop();
        this._loadedOk = true;
    }

    // ── Audio model (speech-commands) ───────────────────────────────────────────

    async _loadAudioModel (model, name) {
        // Mapear índices/labels → nombres de clase
        this._classMap = {};
        this._classLabels = [];
        this._audioLabelToName = {};
        for (const cls of model.classes) {
            this._classMap[cls.index] = cls.name;
            this._classLabels.push(cls.name);
            const label = cls.label || (cls.isNoise ? '_background_noise_' : cls.name);
            this._audioLabelToName[label] = cls.name;
        }

        this._modelName = name;
        this._topClass = '';
        this._topProbability = 0;
        this._allConfidences = {};

        try {
            this._stopAudio();

            // Usar el recognizer YA ENTRENADO compartido en memoria (carga instantánea,
            // sin re-entrenar). Fallback: reconstruir desde los ejemplos serializados.
            const shared = window.playcodeAudioModels && window.playcodeAudioModels[name];
            let fromMemory = false;
            if (shared) {
                this._audioRecognizer = shared;
                fromMemory = true;
            } else {
                this._audioRecognizer = this._baseRecognizer.createTransfer(name);
                this._audioRecognizer.loadExamples(this._base64ToAb(model.audioData));
                await this._audioRecognizer.train({
                    epochs: 40,
                    fineTuningEpochs: 8,
                    augmentByMixingNoiseRatio: 0.5
                });
            }

            this._startAudioListen();
            this._loadedOk = true;
            console.log(`[TM] Modelo de audio "${name}" cargado (${fromMemory ? 'memoria' : 'reentrenado'}). Clases:`, this._classLabels);
        } catch (e) {
            console.error('[TM] Error cargando modelo de audio:', e);
        }

        if (this.runtime && this.runtime.requestToolboxExtensionsUpdate) {
            this.runtime.requestToolboxExtensionsUpdate();
        }
    }

    async _startAudioListen () {
        if (!this._audioRecognizer || this._audioListening) return;
        // El recognizer compartido pudo quedar escuchando desde el ML Studio: liberarlo
        try {
            if (this._audioRecognizer.isListening && this._audioRecognizer.isListening()) {
                await this._audioRecognizer.stopListening();
            }
        } catch (e) { /* noop */ }
        const labels = this._audioRecognizer.wordLabels();
        this._audioRecognizer.listen(
            result => {
                const scores = result.scores;
                const named = {};
                let topName = '';
                let topProb = -1;
                labels.forEach((label, i) => {
                    const name = this._audioLabelToName[label] || label;
                    named[name] = scores[i];
                    if (scores[i] > topProb) {
                        topProb = scores[i];
                        topName = name;
                    }
                });
                this._allConfidences = named;
                this._topClass = topName;
                this._topProbability = topProb;
            },
            {
                probabilityThreshold: 0.5,
                overlapFactor: 0.5,
                includeSpectrogram: false,
                invokeCallbackOnNoiseAndUnknown: true
            }
        );
        this._audioListening = true;
        if (this.runtime) this.runtime.emit('TM_AUDIO_STARTED');
    }

    _stopAudio () {
        if (this._audioRecognizer && this._audioListening) {
            try { this._audioRecognizer.stopListening(); } catch (e) { /* noop */ }
        }
        this._audioListening = false;
        if (this.runtime) this.runtime.emit('TM_AUDIO_STOPPED');
    }

    _base64ToAb (b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    // ── Dynamic menus ─────────────────────────────────────────────────────────

    getModelsMenu () {
        const models = this._getStoredModels();
        const names = Object.keys(models);
        if (names.length === 0) return [{text: 'Crea un modelo en ML Studio', value: ''}];
        return names.map(n => ({text: n, value: n}));
    }

    getClassesMenu () {
        if (this._classLabels.length > 0) {
            return this._classLabels.map(l => ({text: l, value: l}));
        }
        return [{text: 'carga un modelo primero', value: ''}];
    }

    // ── Block implementations ─────────────────────────────────────────────────

    openMLStudio () {
        if (this.runtime) this.runtime.emit('OPEN_ML_STUDIO');
    }

    setCamera (args) {
        if (args.STATE === 'on') return this._enableCamera().then(() => this._startPredictLoop());
        this._disableCamera();
    }

    whenDetects (args) {
        if (!this._classifier || !args.CLASS) return false;
        return this._topClass === args.CLASS;
    }

    whenDetectsConfidence (args) {
        if (!this._classifier || !args.CLASS) return false;
        if (this._topClass !== args.CLASS) return false;
        const threshold = (Number(args.THRESHOLD) || 0) / 100;
        return this._topProbability >= threshold;
    }

    isClass (args) {
        if (!this._classifier || !args.CLASS) return false;
        return this._topClass === args.CLASS;
    }

    currentClass () {
        return this._topClass || '';
    }

    currentConfidence () {
        return Math.round(this._topProbability * 100);
    }

    confidenceOf (args) {
        if (!args.CLASS) return 0;
        return Math.round((this._allConfidences[args.CLASS] || 0) * 100);
    }

    isModelReady () {
        return this._classifier !== null;
    }

    setVideo (args) {
        const state = args.STATE;
        if (state === 'off') {
            this._disableCamera();
            return;
        }
        // 'on' o 'flipped'
        this._videoFlipped = state !== 'noflip';
        if (this.runtime) {
            this.runtime.emit('TM_VIDEO_FLIP', this._videoFlipped);
        }
        return this._enableCamera().then(() => this._startPredictLoop());
    }

    setClassifyInterval (args) {
        const ms = Math.max(50, Math.min(2000, Number(args.INTERVAL) || PREDICT_INTERVAL));
        this._classifyInterval = ms;
        if (this._predictTimer) this._startPredictLoop();
    }

    // Encender/apagar el reconocimiento de audio (modelos de tipo audio)
    setMic (args) {
        if (args.STATE === 'off') {
            this._stopAudio();
            return;
        }
        this._startAudioListen();
    }

    // ── getInfo ───────────────────────────────────────────────────────────────

    getInfo () {
        return {
            id: 'teachablemachine',
            name: 'Teachable Machine',
            color1: '#009688',
            color2: '#00796B',
            color3: '#00695C',
            menuIconURI,
            blockIconURI,
            blocks: [
                {
                    func: 'OPEN_ML_STUDIO',
                    blockType: BlockType.BUTTON,
                    text: 'Abrir ML Studio'
                },
                '---',
                {
                    opcode: 'loadModel',
                    blockType: BlockType.COMMAND,
                    text: 'cargar modelo [MODEL_NAME]',
                    arguments: {
                        MODEL_NAME: {
                            type: ArgumentType.STRING,
                            menu: 'models',
                            defaultValue: ''
                        }
                    }
                },
                {
                    opcode: 'setVideo',
                    blockType: BlockType.COMMAND,
                    text: 'cámara [STATE]',
                    arguments: {
                        STATE: {
                            type: ArgumentType.STRING,
                            menu: 'videoStates',
                            defaultValue: 'on'
                        }
                    }
                },
                {
                    opcode: 'setMic',
                    blockType: BlockType.COMMAND,
                    text: 'micrófono [STATE]',
                    arguments: {
                        STATE: {
                            type: ArgumentType.STRING,
                            menu: 'micStates',
                            defaultValue: 'on'
                        }
                    }
                },
                {
                    opcode: 'setClassifyInterval',
                    blockType: BlockType.COMMAND,
                    text: 'clasificar cada [INTERVAL] ms',
                    arguments: {
                        INTERVAL: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 200
                        }
                    }
                },
                '---',
                {
                    opcode: 'whenDetects',
                    blockType: BlockType.HAT,
                    text: 'cuando detecte [CLASS]',
                    arguments: {
                        CLASS: {
                            type: ArgumentType.STRING,
                            menu: 'classes',
                            defaultValue: ''
                        }
                    }
                },
                {
                    opcode: 'whenDetectsConfidence',
                    blockType: BlockType.HAT,
                    text: 'cuando detecte [CLASS] con confianza > [THRESHOLD] %',
                    arguments: {
                        CLASS: {
                            type: ArgumentType.STRING,
                            menu: 'classes',
                            defaultValue: ''
                        },
                        THRESHOLD: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 80
                        }
                    }
                },
                {
                    opcode: 'isClass',
                    blockType: BlockType.BOOLEAN,
                    text: '¿detecta [CLASS]?',
                    arguments: {
                        CLASS: {
                            type: ArgumentType.STRING,
                            menu: 'classes',
                            defaultValue: ''
                        }
                    }
                },
                '---',
                {
                    opcode: 'currentClass',
                    blockType: BlockType.REPORTER,
                    text: 'clase detectada'
                },
                {
                    opcode: 'currentConfidence',
                    blockType: BlockType.REPORTER,
                    text: 'confianza (%)'
                },
                {
                    opcode: 'confidenceOf',
                    blockType: BlockType.REPORTER,
                    text: 'confianza de [CLASS] (%)',
                    arguments: {
                        CLASS: {
                            type: ArgumentType.STRING,
                            menu: 'classes',
                            defaultValue: ''
                        }
                    }
                },
                {
                    opcode: 'isModelReady',
                    blockType: BlockType.BOOLEAN,
                    text: '¿modelo listo?'
                }
            ],
            menus: {
                models: {
                    acceptReporters: false,
                    items: 'getModelsMenu'
                },
                videoStates: {
                    acceptReporters: false,
                    items: [
                        {text: 'encender', value: 'on'},
                        {text: 'apagar', value: 'off'},
                        {text: 'voltear (espejo)', value: 'flipped'},
                        {text: 'sin voltear', value: 'noflip'}
                    ]
                },
                micStates: {
                    acceptReporters: false,
                    items: [
                        {text: 'encender', value: 'on'},
                        {text: 'apagar', value: 'off'}
                    ]
                },
                classes: {
                    acceptReporters: true,
                    items: 'getClassesMenu'
                }
            }
        };
    }
}

module.exports = Scratch3TeachableMachine;
