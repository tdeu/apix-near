import { sendTip } from '../../../lib/near';
export async function POST(request: Request) {
  const { to, amount } = await request.json();
  const tx = await sendTip(to, BigInt(amount));
  return Response.json({ hash: tx.transaction.hash });
}
