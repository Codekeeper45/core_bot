'use strict';
const baileys = require('../services/baileys');

module.exports = {
  sendMessage: (jid, text) => baileys.sendMessage(jid, text),
  sendTyping: (jid) => baileys.sendTyping(jid),
};
