const amazon = require('./amazon');
const target = require('./target');
const screwfix = require('./screwfix');

const PLATFORMS = [amazon, target, screwfix];

function detectPlatform(url) {
    return PLATFORMS.find((platform) => platform.matches(url)) || null;
}

module.exports = { detectPlatform, PLATFORMS };
