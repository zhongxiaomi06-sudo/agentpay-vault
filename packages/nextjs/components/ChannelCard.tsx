"use client";

import { useState } from "react";
import { encodeAbiParameters, formatEther, keccak256, parseEther, parseSignature } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";
import { structAt } from "~~/utils/scaffold-eth/structAt";

type ChannelStruct = {
  agent: string;
  provider: string;
  budget: bigint;
  expiry: bigint;
  settled: bigint;
  closed: boolean;
};
const CHANNEL_KEYS = ["agent", "provider", "budget", "expiry", "settled", "closed"] as const;

const PRICE_PER_CALL = parseEther("0.0001");

/**
 * ChannelCard —— 按次计量支付通道
 * agent 每次调用只离线签 EIP-712 voucher（金额累计递增），
 * 服务商拿最后一张 voucher 上链批量结算：一万次调用 = 2 笔链上交易
 */
export const ChannelCard = () => {
  const { address } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const { data: deployed } = useDeployedContractInfo({ contractName: "ChannelVault" });
  const [budget] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [channelId, setChannelId] = useState<`0x${string}` | null>(null);
  const [callCount, setCallCount] = useState(0); // 链下调用计数
  const [latestVoucher, setLatestVoucher] = useState<{ amount: bigint; sig: `0x${string}` } | null>(null);

  const { data: channelRaw, refetch } = useScaffoldReadContract({
    contractName: "ChannelVault",
    functionName: "channels",
    args: [channelId ?? ("0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`)],
  });
  const ch = structAt<ChannelStruct>(channelRaw, CHANNEL_KEYS);

  const { data: nonceData } = useScaffoldReadContract({ contractName: "ChannelVault", functionName: "channelNonce" });
  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "ChannelVault" });
  const { signTypedDataAsync } = useSignTypedData();

  const open = async () => {
    if (!address || !deployed) return notification.error("先连接钱包");
    setBusy(true);
    try {
      await writeContractAsync({
        functionName: "openChannel",
        args: [address, 3600n],
        value: parseEther(budget),
      });
      // 通道 ID = keccak256(agent, provider, nonce)
      const nextNonce = (nonceData ?? 0n) + 1n;
      const id = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint256" }],
          [address, address, nextNonce],
        ),
      );
      setChannelId(id);
      setCallCount(0);
      setLatestVoucher(null);
      notification.success("通道已开启（链上交易 #1）");
      refetch();
    } catch (e) {
      console.error(e);
      notification.error("开通道失败");
    } finally {
      setBusy(false);
    }
  };

  /** 一次"API 调用" = 纯离线签名，不发链上交易 */
  const callApiOffchain = async () => {
    if (!address || !deployed || !channelId) return;
    setBusy(true);
    try {
      const next = callCount + 1;
      const cumulativeAmount = PRICE_PER_CALL * BigInt(next);
      const sig = await signTypedDataAsync({
        domain: {
          name: "AgentPayChannelVault",
          version: "1",
          chainId: targetNetwork.id,
          verifyingContract: deployed.address,
        },
        types: {
          Voucher: [
            { name: "channelId", type: "bytes32" },
            { name: "cumulativeAmount", type: "uint256" },
          ],
        },
        primaryType: "Voucher",
        message: { channelId, cumulativeAmount },
      });
      setCallCount(next);
      setLatestVoucher({ amount: cumulativeAmount, sig });
      notification.success(`第 ${next} 次调用完成（离线签名，0 gas）`);
    } catch (e) {
      console.error(e);
      notification.error("签名取消或失败");
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    if (!latestVoucher || !channelId) return;
    setBusy(true);
    try {
      const { r, s, yParity } = parseSignature(latestVoucher.sig);
      await writeContractAsync({
        functionName: "claim",
        args: [channelId, latestVoucher.amount, 27 + (yParity ?? 0), r, s],
      });
      notification.success(`已结算 ${callCount} 次调用（链上交易 #2）`);
      refetch();
    } catch (e) {
      console.error(e);
      notification.error("结算失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-base-200 border border-warning/30">
      <div className="card-body gap-3">
        <h2 className="card-title">🎟️ 按次计量通道</h2>
        <p className="text-xs text-base-content/60 -mt-2">
          EIP-712 voucher 离线签名，累计金额单调递增 —— 一万次调用 = 2 笔链上交易
        </p>

        {!channelId ? (
          <button className="btn btn-sm btn-warning w-fit" disabled={busy} onClick={open}>
            开启通道（锁 {budget} MON 预算）
          </button>
        ) : (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm flex flex-col gap-2">
            <div className="flex justify-between flex-wrap gap-2">
              <span>通道 {channelId.slice(0, 10)}…</span>
              <span>
                已链上结算: <b className="text-warning">{formatEther(ch?.settled ?? 0n)}</b> /{" "}
                {formatEther(ch?.budget ?? 0n)} MON
              </span>
            </div>

            <div className="stats stats-horizontal shadow bg-base-100">
              <div className="stat py-2 px-4">
                <div className="stat-title text-xs">离线调用次数</div>
                <div className="stat-value text-lg text-accent">{callCount}</div>
                <div className="stat-desc">0 gas × {callCount}</div>
              </div>
              <div className="stat py-2 px-4">
                <div className="stat-title text-xs">链上交易</div>
                <div className="stat-value text-lg">{ch && ch.settled > 0n ? 2 : 1}</div>
                <div className="stat-desc">开 + 结</div>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-sm btn-accent" disabled={busy} onClick={callApiOffchain}>
                ⚡ 调一次 API（只签名不上链）
              </button>
              <button className="btn btn-sm btn-warning" disabled={busy || !latestVoucher} onClick={settle}>
                服务商拿最后一张 voucher 结算
              </button>
            </div>
            {latestVoucher && (
              <div className="text-xs text-base-content/50 break-all">
                最新 voucher: 累计 {formatEther(latestVoucher.amount)} MON · sig {latestVoucher.sig.slice(0, 20)}…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
