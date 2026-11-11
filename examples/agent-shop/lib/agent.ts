// The shopping agent: a model that can pay, but only through the vault.
// Whatever it is told (including by a prompt injection), the vault contract
// caps each payment and the daily total, and only allowlisted shops can be paid.
import 'server-only';
import OpenAI from 'openai';
import { openAiTools, runVaultTool } from './near/agent-tools';

export async function runShoppingAgent(task: string): Promise<string> {
  const client = new OpenAI();
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You buy what the user asks for from allowlisted NEAR shops. Check the vault status before paying.' },
    { role: 'user', content: task },
  ];
  for (let turn = 0; turn < 6; turn++) {
    const reply = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages, tools: openAiTools });
    const message = reply.choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) return message.content ?? '';
    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;
      const result = await runVaultTool(call.function.name, JSON.parse(call.function.arguments || '{}'));
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return 'Stopped after 6 turns.';
}
