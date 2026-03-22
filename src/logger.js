const pino = require('pino');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Configure Pino to omit pid, hostname, and default time so we can strictly match the contract
const logger = pino(
  { 
    base: undefined, 
    timestamp: false,
    formatters: {
      level: () => ({}) // Omits the "level" property from JSON
    }
  },
  pino.destination(path.join(logDir, 'app.log'))
);

module.exports = logger;