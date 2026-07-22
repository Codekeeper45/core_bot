'use strict';

// Serverix egg compares MAIN_FILE with the literal string "*.js". This tiny
// bootstrap makes that fallback value start the normal CommonJS application.
require('./src/index.js');
