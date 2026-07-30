// src/extensions/playboard/index.js
const PlayBoard = require('./blocks');

module.exports = function(runtime) {
    return new PlayBoard(runtime, 'playboard');
};
