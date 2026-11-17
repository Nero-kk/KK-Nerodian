const { Platform } = require('obsidian');
module.exports = Platform.isMobile ? require('./mobile').default : require('./main').default;
