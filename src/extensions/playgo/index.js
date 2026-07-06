const PlayGo = require('./blocks');

module.exports = function(runtime) {
    return new PlayGo(runtime, 'playgo');
};
