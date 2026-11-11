'use client';
import { KeyPair } from 'near-api-js';
export function Wallet() { const kp = KeyPair.fromString(process.env.NEXT_PUBLIC_NEAR_PRIVATE_KEY as any); return null; }
