'use strict';
const baileys = require('../services/baileys');

module.exports = {
  sendMessage: (jid, text) => baileys.sendMessage(jid, text),
  sendPhoto: (jid, buffer, caption) => baileys.sendImage(jid, buffer, caption),
  sendVoice: (jid, buffer) => baileys.sendVoice(jid, buffer),
  sendTyping: (jid) => baileys.sendTyping(jid),
};
