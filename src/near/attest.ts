// src/near/attest.ts
import { Account, actions, teraToGas } from 'near-api-js';
import { loadWasm } from './vault';
import { isValidAccountId } from './network';
import { VerifyReport } from '../verify/types';
import { reportHash } from '../verify/report';
import { NearNetwork, provider } from './config';

export interface OnChainAttestation {
  attester: string;
  app_id: string;
  report_hash: string;
  verdict: string;
  checks_run: number;
  failures: number;
  warnings: number;
  apix_version: string;
  source: string | null;
  timestamp_ns: number;
  revision: number;
}

export async function attestReport(
  attester: Account,
  contractId: string,
  report: VerifyReport,
  source?: string
): Promise<{ txHash: string; hash: string }> {
  const hash = reportHash(report);
  const result = await attester.callFunctionRaw({
    contractId,
    methodName: 'attest',
    args: {
      input: {
        app_id: report.appId.slice(0, 200),
        report_hash: hash,
        verdict: report.summary.verdict,
        checks_run: report.summary.checksRun,
        failures: report.summary.failures,
        warnings: report.summary.warnings,
        apix_version: report.apixVersion.slice(0, 32),
        source: source ? source.slice(0, 200) : null,
      },
    },
    deposit: 10_000_000_000_000_000_000_000n, // 0.01 NEAR, unused part refunded
    gas: teraToGas('30'),
    waitUntil: 'FINAL',
  });
  return { txHash: result.transaction.hash, hash };
}

export async function readAttestation(
  network: NearNetwork,
  contractId: string,
  attester: string,
  appId: string
): Promise<OnChainAttestation | null> {
  const value = await provider(network).callFunction<OnChainAttestation>({
    contractId,
    method: 'get_attestation',
    args: { attester, app_id: appId },
  });
  return (value as OnChainAttestation | undefined) ?? null;
}

/**
 * Creates <name>.<owner>, deploys the attestation contract and initialises it
 * in one transaction, with no access key at all: the code and the records can
 * never be changed by anyone, the deployer included.
 */
export async function deployAttestations(owner: Account, name: string, fund: bigint): Promise<{ contractId: string; txHash: string }> {
  const contractId = `${name}.${owner.accountId}`;
  if (!isValidAccountId(contractId)) throw new Error(`"${contractId}" is not a valid account id.`);
  const wasm = await loadWasm('apix_attestations');
  const result = await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      actions.transfer(fund),
      actions.deployContract(wasm),
      actions.functionCall('new', {}, teraToGas('30'), 0n),
    ],
    waitUntil: 'FINAL',
  });
  return { contractId, txHash: result.transaction.hash };
}
