const PlayMe = require('./blocks');

module.exports = function(runtime) {
    return new PlayMe(runtime, 'playme');
};