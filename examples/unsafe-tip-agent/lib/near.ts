import { Account, JsonRpcProvider } from 'near-api-js';
const provider = new JsonRpcProvider({ url: 'https://rpc.mainnet.near.org' });
export const account = new Account(process.env.NEAR_ACCOUNT_ID!, provider, process.env.NEAR_PRIVATE_KEY as any);
export async function sendTip(to: string, amount: bigint) {
  return account.transfer({ receiverId: to, amount });
}
