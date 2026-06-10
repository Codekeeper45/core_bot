const {
  maskPhone,
  maskName,
  maskBin,
  maskEmail,
  maskPiiInObject,
} = require('./piiMask.js');

function maskContext(context) {
  if (context == null || typeof context !== 'object') return context;

  const masked = Array.isArray(context) ? context.map(maskContext) : { ...context };

  if (Array.isArray(masked)) return masked;

  if (Object.prototype.hasOwnProperty.call(masked, 'phone')) masked.phone = maskPhone(masked.phone);
  if (Object.prototype.hasOwnProperty.call(masked, 'client_name')) masked.client_name = maskName(masked.client_name);
  if (Object.prototype.hasOwnProperty.call(masked, 'business_name_bin')) masked.business_name_bin = maskBin(masked.business_name_bin);
  if (Object.prototype.hasOwnProperty.call(masked, 'email')) masked.email = maskEmail(masked.email);

  return maskPiiInObject(masked);
}

function log(level, module, message, context, options = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };

  if (context !== undefined) {
    entry.context = options.maskPii === false ? context : maskContext(context);
  }

  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const logger = {
  info(module, message, context, options) {
    log('info', module, message, context, options);
  },
  warn(module, message, context, options) {
    log('warn', module, message, context, options);
  },
  error(module, message, context, options) {
    log('error', module, message, context, options);
  },
};

module.exports = { logger };
