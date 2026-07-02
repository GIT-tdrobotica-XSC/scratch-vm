const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');

const blockIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB4PSI2IiB5PSIxMCIgd2lkdGg9IjI4IiBoZWlnaHQ9IjIwIiByeD0iMyIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSIjMDA5Njg4IiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSI1IiBmaWxsPSIjMDA5Njg4Ii8+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMiIgZmlsbD0iI2ZmZiIvPjxyZWN0IHg9IjE1IiB5PSI2IiB3aWR0aD0iMTAiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiMwMDk2ODgiLz48L3N2Zz4=';
const menuIconURI = blockIconURI;

// UNA sola versión de tfjs (1.5.2, stack de Google TM). Dos versiones de tfjs colisionan
// en el engine global. speech-commands exige ^1.5.2; mobilenet/knn/posenet 1.x también
// funcionan con 1.5.2. (Pose usa PoseNet, no MoveNet, que requiere tfjs 3.x.)
const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.5.2/dist/tf.min.js';
const MOBILENET_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.0/dist/mobilenet.min.js';
const KNN_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1.2.4/dist/knn-classifier.min.js';
const POSENET_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/posenet@2.2.2/dist/posenet.min.js';
const SPEECH_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.4.2/dist/speech-commands.min.js';

// speech-commands (BROWSER_FFT) espera audio a 44100 Hz; muchos sistemas usan 48000 →
// el espectrograma se desalinea y baja la precisión. Forzamos el AudioContext a 44100.
function forceAudioSampleRate () {
    const Orig = window.AudioContext || window.webkitAudioContext;
    if (!Orig || Orig.__pcPatched) return;
    class PatchedAudioContext extends Orig {
        constructor (opts) {
            super(Object.assign({sampleRate: 44100}, opts || {}));
        }
    }
    PatchedAudioContext.__pcPatched = true;
    window.AudioContext = PatchedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
}
const PREDICT_INTERVAL = 200;
const POSE_MIN_SCORE = 0.2;
// Como invokeCallbackOnNoiseAndUnknown=true hace que speech-commands invoque el
// callback SIEMPRE (ignora su propio probabilityThreshold), aplicamos nuestro
// propio umbral + suavizado sobre los scores promediados (igual que Google TM).
const AUDIO_THRESHOLD = 0.75;
// 2 (no más): con 4 lecturas, un pico real de ~95% se diluía con las lecturas vecinas
// más bajas de un sonido breve (aplausos, palabras cortas) y nunca cruzaba el umbral.
const AUDIO_SMOOTH_WINDOW = 2;

// ── Persistencia (IndexedDB) ──────────────────────────────────────────────────
// Los modelos ahora se guardan entre sesiones en IndexedDB (antes solo vivían en
// window.playcodeMLModels, memoria de la sesión). Este helper está duplicado en
// scratch-gui/ml-studio.jsx (paquetes separados, sin import cruzado); ambos leen
// y escriben la misma DB del navegador. window.playcodeMLModels sigue siendo la
// caché sincrónica que consume getModelsMenu (los menús de Scratch no pueden
// esperar una promesa).
const ML_DB_NAME = 'playcode-ml-studio';
const ML_DB_STORE = 'models';

function _openMlDb () {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(ML_DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(ML_DB_STORE)) {
                req.result.createObjectStore(ML_DB_STORE, {keyPath: 'name'});
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function mlDbGetAll () {
    const db = await _openMlDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(ML_DB_STORE, 'readonly').objectStore(ML_DB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// Une lo guardado en IndexedDB con lo que ya haya en memoria de esta sesión (lo
// de memoria gana: puede reflejar guardados/borrados más recientes que todavía
// no terminaron de escribirse en la DB).
function hydrateMlModelsFromDb () {
    if (window.__pcMlHydratePromise) return window.__pcMlHydratePromise;
    window.__pcMlHydratePromise = (async () => {
        try {
            const rows = await mlDbGetAll();
            const fromDb = {};
            rows.forEach(m => { fromDb[m.name] = m; });
            window.playcodeMLModels = Object.assign({}, fromDb, window.playcodeMLModels || {});
        } catch (e) {
            console.warn('[TM] No se pudo leer IndexedDB:', e);
        }
    })();
    return window.__pcMlHydratePromise;
}

class Scratch3TeachableMachine {
    constructor (runtime) {
        this.runtime = runtime;

        // Exponer runtime para que el ML Studio pueda emitir eventos
        window.__scratchVMRuntime = runtime;

        // Estado de librerías
        this._libReady = false;

        // Modelo KNN
        this._classifier = null;
        this._mobilenet = null;
        this._posenet = null;  // PoseNet (tfjs 1.x)
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

        // La GUI envía estos eventos cuando el usuario cierra el widget (botón ×).
        // Detenemos la inferencia del VM para que quede consistente con la UI.
        runtime.on('TM_CLOSE_CAMERA', () => this._disableCamera());
        runtime.on('TM_CLOSE_AUDIO', () => this._stopAudio());

        // Modelos guardados en sesiones anteriores (IndexedDB): el bloque "cargar
        // modelo" debe poder listarlos sin que el usuario tenga que abrir ML Studio
        // primero en esta sesión.
        hydrateMlModelsFromDb().then(() => {
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
        // Cache de promesas en window: el panel ML Studio (ml-studio.jsx) carga los
        // MISMOS CDN (tfjs, speech-commands, etc.) por su cuenta. Antes cada lado hacía
        // su propio querySelector + addEventListener('load', ...) sobre el <script> del
        // otro: si el load ya había disparado entre el check y el addEventListener, ese
        // listener nunca se ejecutaba y la promesa quedaba colgada para siempre (eso
        // traba "cargar modelo", que es async, y con él la bandera verde). Una única
        // promesa compartida por URL evita esa carrera.
        if (!window.__pcScriptPromises) window.__pcScriptPromises = {};
        if (window.__pcScriptPromises[src]) return window.__pcScriptPromises[src];
        const p = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing && existing.getAttribute('data-loaded') === 'true') return resolve();
            const s = existing || document.createElement('script');
            if (!existing) {
                s.src = src;
                s.async = true;
                document.head.appendChild(s);
            }
            s.addEventListener('load', () => { s.setAttribute('data-loaded', 'true'); resolve(); });
            s.addEventListener('error', () => reject(new Error(`No se pudo cargar ${src}`)));
        });
        window.__pcScriptPromises[src] = p;
        return p;
    }

    // Carga las librerías necesarias según el tipo de modelo.
    // image → MobileNet · pose → PoseNet · audio → SpeechCommands. TF.js siempre.
    async _loadLibrary (type) {
        await this._injectScript(TFJS_URL); // tfjs 1.5.2 para TODO
        console.log(`[TM] tfjs ${window.tf && window.tf.version_core ? window.tf.version_core : '?'} listo`);

        if (type === 'audio') {
            forceAudioSampleRate(); // 44100 Hz (evita el mismatch que daña la precisión)
            await this._injectScript(SPEECH_URL);
            if (!this._baseRecognizer) {
                this._baseRecognizer = window.speechCommands.create('BROWSER_FFT');
                await this._baseRecognizer.ensureModelLoaded();
            }
            console.log('[TM] speech-commands listo');
            this._libReady = true;
            return;
        }

        await this._injectScript(KNN_URL);
        if (type === 'pose') {
            await this._injectScript(POSENET_URL);
            if (!this._posenet) {
                this._posenet = await window.posenet.load({
                    architecture: 'MobileNetV1',
                    outputStride: 16,
                    inputResolution: {width: 257, height: 257},
                    multiplier: 0.75
                });
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
    // PoseNet: keypoints con {position:{x,y}, score, part}
    _poseToVector (pose) {
        if (!pose || !pose.keypoints) return null;
        const kp = pose.keypoints;
        const valid = kp.filter(k => (k.score || 0) >= POSE_MIN_SCORE);
        if (valid.length < 5) return null;
        const xs = kp.map(k => k.position.x);
        const ys = kp.map(k => k.position.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = (maxX - minX) || 1;
        const h = (maxY - minY) || 1;
        const vec = [];
        for (const k of kp) {
            vec.push((k.position.x - minX) / w);
            vec.push((k.position.y - minY) / h);
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
        this._predictLoggedErr = false;
        this._confidenceBuffer = [];
        this._predictTimer = setInterval(async () => {
            if (!this._cameraOn || !this._classifier) return;
            const extractor = this._modelType === 'pose' ? this._posenet : this._mobilenet;
            if (!extractor) return;
            if (!this._videoEl || this._videoEl.readyState < 2) return;
            if (this._isPredicting) return;
            if (this._classifier.getNumClasses() < 2) return;

            this._isPredicting = true;
            try {
                let features;
                if (this._modelType === 'pose') {
                    // PoseNet rescala coordenadas usando los atributos HTML width/height
                    // (no videoWidth/videoHeight). El video oculto no tiene esos atributos
                    // puestos → todos los keypoints salen en (0,0) → vector todo ceros
                    // → KNN nunca detecta ninguna clase. Mismo fix que en ml-studio.jsx.
                    if (this._videoEl.width !== this._videoEl.videoWidth) {
                        this._videoEl.width = this._videoEl.videoWidth;
                    }
                    if (this._videoEl.height !== this._videoEl.videoHeight) {
                        this._videoEl.height = this._videoEl.videoHeight;
                    }
                    const pose = await this._posenet.estimateSinglePose(
                        this._videoEl, {flipHorizontal: false}
                    );
                    const vec = this._poseToVector(pose);
                    if (!vec) { this._isPredicting = false; return; }
                    features = window.tf.tensor1d(vec);
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
            } catch (e) {
                if (!this._predictLoggedErr) {
                    console.error('[TM] Error en predicción (imagen/pose):', e);
                    this._predictLoggedErr = true;
                }
            }
            this._isPredicting = false;
        }, this._classifyInterval);
    }

    // ── Load saved model ──────────────────────────────────────────────────────

    _getStoredModels () {
        return window.playcodeMLModels || {};
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

        // Limpiar modelo anterior antes de cambiar de tipo para evitar
        // que cámara y audio se solapen durante la transición.
        const prevType = this._modelType;
        const newType = model.type || 'image';
        if (prevType === 'audio') this._stopAudio();          // audio → cualquier tipo
        if (newType === 'audio' && this._cameraOn) this._disableCamera(); // visual → audio

        // Detectar tipo (image/pose/audio) y cargar la librería correcta
        this._modelType = newType;
        console.log(`[TM] loadModel "${name}" (tipo: ${this._modelType})`);
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
            dataset[label] = window.tf.tensor2d(data, shape);
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
        } catch (e) {
            console.warn('[TM] stopListening previo:', e);
        }
        const labels = this._audioRecognizer.wordLabels();
        console.log('[TM] Escuchando audio. wordLabels:', labels);
        this._audioConfBuffer = [];
        this._audioRecognizer.listen(
            result => {
                const scores = result.scores;

                // Suavizado temporal: promediar las últimas N lecturas (igual que
                // imagen/pose) para que un pico de ruido no dispare una clase.
                this._audioConfBuffer.push(scores);
                if (this._audioConfBuffer.length > AUDIO_SMOOTH_WINDOW) this._audioConfBuffer.shift();
                const avg = new Array(scores.length).fill(0);
                for (const s of this._audioConfBuffer) {
                    for (let i = 0; i < s.length; i++) avg[i] += s[i];
                }
                for (let i = 0; i < avg.length; i++) avg[i] /= this._audioConfBuffer.length;

                const named = {};
                let topName = '';
                let topProb = -1;
                labels.forEach((label, i) => {
                    const name = this._audioLabelToName[label] || label;
                    named[name] = avg[i];
                    if (avg[i] > topProb) {
                        topProb = avg[i];
                        topName = name;
                    }
                });
                this._allConfidences = named;
                // Solo reporta una clase "ganadora" si supera el umbral propio;
                // si no, no hay detección clara (evita falsos positivos entre clases).
                this._topClass = topProb >= AUDIO_THRESHOLD ? topName : '';
                this._topProbability = topProb;

                // Log de diagnóstico (1 de cada 5 lecturas, ~cada 1s) para ver si el
                // modelo realmente cruza AUDIO_THRESHOLD durante el uso real.
                this._audioLogCounter = (this._audioLogCounter || 0) + 1;
                if (this._audioLogCounter % 5 === 0) {
                    const fmt = Object.entries(named).map(([n, p]) => `${n}: ${(p * 100).toFixed(0)}%`).join(' | ');
                    console.log(`[TM] audio live → ${fmt} ${topProb >= AUDIO_THRESHOLD ? `→ GANA "${topName}"` : '(bajo umbral, sin detección)'}`);
                }
            },
            {
                probabilityThreshold: AUDIO_THRESHOLD,
                // 0.35 (no 0.5): cada ventana de análisis corre inferencia WebGL, que
                // compite por GPU con el render del stage de Scratch. Menos ventanas/seg
                // = menos contención = menos tartamudeo, sin perder calidad de detección.
                overlapFactor: 0.35,
                includeSpectrogram: false,
                invokeCallbackOnNoiseAndUnknown: true
            }
        );
        this._audioListening = true;
        if (this.runtime) this.runtime.emit('TM_AUDIO_STARTED');
    }

    _stopAudio () {
        if (this._audioRecognizer && this._audioListening) {
            try { this._audioRecognizer.stopListening(); } catch (e) {
                console.warn('[TM] stopListening:', e);
            }
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

    // Para imagen/pose el modelo activo es _classifier (KNN); para audio es
    // _audioRecognizer (speech-commands). Los bloques deben chequear el que
    // corresponda según _modelType, no solo _classifier.
    _hasActiveModel () {
        if (this._modelType === 'audio') return !!this._audioRecognizer && this._loadedOk;
        return this._classifier !== null;
    }

    whenDetects (args) {
        if (!this._hasActiveModel() || !args.CLASS) return false;
        return this._topClass === args.CLASS;
    }

    whenDetectsConfidence (args) {
        if (!this._hasActiveModel() || !args.CLASS) return false;
        if (this._topClass !== args.CLASS) return false;
        const threshold = (Number(args.THRESHOLD) || 0) / 100;
        return this._topProbability >= threshold;
    }

    isClass (args) {
        if (!this._hasActiveModel() || !args.CLASS) return false;
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
        return this._hasActiveModel();
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
                    // isEdgeActivated: solo dispara en el flanco falso→verdadero.
                    // Sin esto Scratch re-lanza el script cada frame que la clase
                    // siga detectada, acumulando instancias y dejando la bandera pegada.
                    isEdgeActivated: true,
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
                    isEdgeActivated: true,
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
