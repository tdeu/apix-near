import { AgentVaultStatus } from '../components/near/AgentVaultStatus';
import { ConnectWallet } from '../components/near/ConnectWallet';
import { TokenPanel } from '../components/near/TokenPanel';
export default function Home() {
  return <main style={{ padding: 32 }}><h1>Agent shop</h1><ConnectWallet /><TokenPanel /><AgentVaultStatus /></main>;
}
