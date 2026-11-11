import OpenAI from 'openai';
import { sendTip } from './near';
const openai = new OpenAI();
export const tools = [{ type: 'function', function: { name: 'send_tip', parameters: {} } }];
export async function runTool(args: any) { return sendTip(args.to, BigInt(args.amount)); }
