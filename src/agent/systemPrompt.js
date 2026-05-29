'use strict';
const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_RAW = fs.readFileSync(
  path.join(__dirname, 'prompts/system_prompt.txt'), 'utf8'
);

function getSystemPrompt(clientName, phone, channel) {
  const prompt = SYSTEM_PROMPT_RAW;

  const userContext = `

=== КОНТЕКСТ ПОЛЬЗОВАТЕЛЯ ===
Имя: ${clientName || 'не указано'}
Телефон: ${phone || 'не указан'}
Канал: ${channel || 'не указан'}
=== КОНЕЦ КОНТЕКСТА ===`;

  return prompt + userContext;
}

module.exports = { getSystemPrompt };
