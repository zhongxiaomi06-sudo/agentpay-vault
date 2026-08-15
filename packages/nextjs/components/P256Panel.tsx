"use client";

import { useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { p256 } from "@noble/curves/nist.js";
import { usePublicClient } from "wagmi";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

const P256_PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex").padStart(64, "0");

/**
 * P256Panel —— Monad 独占杀招：原生 P256 precompile
 * AI agent 的 passkey / Secure Enclave 密钥就是 secp256r1，
 * 别的链验这种签名要几十万 gas，Monad 一次 precompile 调用搞定
 */
export const P256Panel = () => {
  const publicClient = usePublicClient();
  const { targetNetwork } = useTargetNetwork();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; gas: string } | null>(null);

  const run = async () => {
    if (!publicClient) return;
    setBusy(true);
    try {
      // 浏览器内生成 P256 密钥对，模拟 AI agent 的 Secure Enclave 密钥
      const priv = p256.utils.randomPrivateKey();
      const pub = p256.getPublicKey(priv, false); // 0x04 || x || y
      const msgHash = sha256(new TextEncoder().encode(`agentpay-release-${Date.now()}`));
      const sig = p256.sign(msgHash, priv);
      const compact = sig.toCompactRawBytes();
      const data = ("0x" +
        hex(msgHash) +
        hex(compact.slice(0, 32)) +
        hex(compact.slice(32, 64)) +
        hex(pub.slice(1, 33)) +
        hex(pub.slice(33, 65))) as `0x${string}`;

      // 直接调 Monad 的 P256 precompile（RIP-7212）
      const callResult = await publicClient.call({ to: P256_PRECOMPILE, data });
      const verified = callResult.data === "0x" + "0".repeat(63) + "1";

      let gas = "—";
      try {
        const est = await publicClient.estimateGas({ to: P256_PRECOMPILE, data });
        gas = est.toString();
      } catch {
        gas = "≈3450 (RIP-7212)";
      }
      setResult({ verified, gas });
    } catch (e) {
      console.error(e);
      setResult({ verified: false, gas: "调用失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-gradient-to-br from-primary/10 to-secondary/10 border border-primary">
      <div className="card-body gap-3">
        <h2 className="card-title">🔐 P256 原生验证 <span className="badge badge-primary">Monad 独占</span></h2>
        <p className="text-xs text-base-content/70">
          AI agent 常用 passkey / Secure Enclave 密钥（secp256r1）。别的链用 Solidity 验这种签名要烧几十万 gas，
          Monad 内置 P256 precompile（RIP-7212）——agent 用设备密钥直接签名确认 Escrow 交付。
        </p>
        <div className="flex gap-3 items-center flex-wrap">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={run}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : "🔑"} 模拟 agent 密钥签名并链上验证
          </button>
          {result && (
            <div className="font-mono text-sm">
              {result.verified ? (
                <span className="text-success font-bold">✓ precompile 验证通过</span>
              ) : (
                <span className="text-error">验证失败</span>
              )}
              <span className="text-base-content/60 ml-2">gas: {result.gas}</span>
              <span className="text-base-content/40 ml-2">@ {targetNetwork.name}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
