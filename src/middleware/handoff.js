'use strict';
const { getHandoff, appendHandoffHistory, getAndClearHandoffHistory } = require('../services/mysql');

async function checkHandoff(channel, chatId, combinedMessage) {
  const handoff = await getHandoff(channel, chatId);

  if (handoff && handoff.active) {
    await appendHandoffHistory(channel, chatId, combinedMessage);
    return { muted: true };
  }

  const history = await getAndClearHandoffHistory(channel, chatId);
  let finalMessage = combinedMessage;

  if (history.length > 0) {
    const lines = history.map(h => `[${h.ts}] ${h.message}`);
    finalMessage = `[ИСТОРИЯ ВО ВРЕМЯ ПАУЗЫ:\n${lines.join('\n')}\n]\n\n${combinedMessage}`;
  }

  return { muted: false, message: finalMessage };
}

module.exports = { checkHandoff };
