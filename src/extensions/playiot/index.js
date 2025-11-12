// src/extensions/playiot/index.js
const PlayIoT = require('./blocks');

module.exports = function(runtime) {
    return new PlayIoT(runtime, 'playiot');
};
