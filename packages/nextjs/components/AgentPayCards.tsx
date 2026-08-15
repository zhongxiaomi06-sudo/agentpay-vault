"use client";

import { useEffect, useState } from "react";
import { formatEther, hexToSignature, parseEther, zeroAddress } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { useDeployedContractInfo, useScaffoldEventHistory, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

/**
 * StreamCard —— 流支付金库：按秒流式付费，余额实时流动
 */
export const StreamCard = () => {
  const { address } = useAccount();
  const [rate, setRate] = useState("0.00001"); // MON/秒
  const [deposit, setDeposit] = useState("0.01"); // 总押金 MON
  const [busy, setBusy] = useState(false);
  const [nowSec, setNowSec] = useState(0); // 每秒刷新驱动余额流动（effect 内取时，满足 React 渲染纯度）

  useEffect(() => {
    const update = () => setNowSec(Math.floor(Date.now() / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  const { data: streamCount } = useScaffoldReadContract({ contractName: "AgentPayVault", functionName: "streamCount" });
  const latestId = streamCount ? BigInt(streamCount.toString()) : 0n;

  const { data: streamRaw } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "streams",
    args: [latestId],
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault" });

  // viem 返回 struct 为带名字段对象；做一层防御性兼容
  const s = streamRaw as unknown as
    | { payer: string; payee: string; deposit: bigint; ratePerSecond: bigint; start: bigint; withdrawn: bigint; active: boolean }
    | undefined;
  const active = s?.active;
  const elapsed = s && nowSec > 0 ? Math.max(0, nowSec - Number(s.start)) : 0;
  const accrued = s ? BigInt(elapsed) * s.ratePerSecond : 0n;
  const earnedNow = s ? (accrued > s.deposit ? s.deposit : accrued) : 0n;
  const liveEarned = active ? earnedNow : 0n;

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!address) return notification.error("请先连接钱包");
    setBusy(true);
    try {
      await fn();
      notification.success(okMsg);
    } catch (e) {
      console.error(e);
      notification.error("交易失败，看控制台");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-base-200 border border-primary/30">
      <div className="card-body gap-3">
        <h2 className="card-title">🌊 流支付金库</h2>
        <p className="text-xs text-base-content/60 -mt-2">agent 预付押金，按秒流式付费给服务商，随用随取</p>

        <div className="flex gap-2 flex-wrap items-center">
          <label className="input input-sm flex items-center gap-1">
            费率
            <input className="w-20" value={rate} onChange={e => setRate(e.target.value)} />
            MON/s
          </label>
          <label className="input input-sm flex items-center gap-1">
            押金
            <input className="w-20" value={deposit} onChange={e => setDeposit(e.target.value)} />
            MON
          </label>
          <button
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() =>
              act(
                () =>
                  writeContractAsync({
                    functionName: "openStream",
                    args: [address!, parseEther(rate)],
                    value: parseEther(deposit),
                  }),
                "金库已开启，开始流式计费！",
              )
            }
          >
            开启金库
          </button>
        </div>

        {latestId > 0n && s && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm">
            <div className="flex justify-between">
              <span>Stream #{latestId.toString()}</span>
              <span className={active ? "text-success" : "text-base-content/50"}>{active ? "● 流动中" : "已关闭"}</span>
            </div>
            <div className="mt-2">
              已流动 <span className="text-xl font-bold text-primary">{formatEther(liveEarned)}</span> MON
              <span className="text-base-content/50"> / 押金 {formatEther(s.deposit)} MON</span>
            </div>
            <progress
              className="progress progress-primary w-full mt-2"
              value={Number(liveEarned)}
              max={Number(s.deposit) || 1}
            />
            <div className="flex gap-2 mt-3">
              <button
                className="btn btn-xs btn-secondary"
                disabled={busy || !active}
                onClick={() => act(() => writeContractAsync({ functionName: "withdrawStream", args: [latestId] }), "服务商已提现")}
              >
                服务商提现
              </button>
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy || !active}
                onClick={() => act(() => writeContractAsync({ functionName: "closeStream", args: [latestId] }), "金库已关闭，余额退回")}
              >
                关闭结算
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * PlanCard —— 按次付费订阅：预付 N 次，调用扣 1 次，服务商记账提现
 */
export const PlanCard = () => {
  const { address } = useAccount();
  const [price] = useState("0.0001");
  const [calls, setCalls] = useState("10");
  const [busy, setBusy] = useState(false);

  const { data: planCount } = useScaffoldReadContract({ contractName: "AgentPayVault", functionName: "planCount" });
  const latestPlan = planCount && planCount > 0n ? planCount : 0n;

  const { data: myCredits, refetch: refetchCredits } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "credits",
    args: [latestPlan, address],
  });

  const { data: myPending } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "pending",
    args: [address],
  });

  const { data: myCallSeq, refetch: refetchSeq } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "callSeq",
    args: [latestPlan, address],
  });

  const { data: callEvents } = useScaffoldEventHistory({
    contractName: "AgentPayVault",
    eventName: "ServiceCalled",
    watch: true,
    fromBlock: 0n,
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault" });
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "AgentPayVault" });
  const { targetNetwork } = useTargetNetwork();
  const { signTypedDataAsync } = useSignTypedData();

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!address) return notification.error("请先连接钱包");
    setBusy(true);
    try {
      await fn();
      notification.success(okMsg);
      refetchCredits();
    } catch (e) {
      console.error(e);
      notification.error("交易失败，看控制台");
    } finally {
      setBusy(false);
    }
  };

  // x402 真实流程：agent 离线签 MeterAuth 授权 → 服务商持签名调 meter() 链上记账
  const [apiResult, setApiResult] = useState<string | null>(null);
  const callPaidApi = () =>
    act(async () => {
      if (!vaultInfo || !address) throw new Error("no vault");
      const callIndex = myCallSeq ?? 0n;
      const sig = await signTypedDataAsync({
        domain: {
          name: "AgentPayVault",
          version: "1",
          chainId: targetNetwork.id,
          verifyingContract: vaultInfo.address,
        },
        types: {
          MeterAuth: [
            { name: "planId", type: "uint256" },
            { name: "agent", type: "address" },
            { name: "callIndex", type: "uint256" },
          ],
        },
        primaryType: "MeterAuth",
        message: { planId: latestPlan, agent: address, callIndex },
      });
      const { r, s, yParity } = hexToSignature(sig);
      await writeContractAsync({
        functionName: "meter",
        args: [latestPlan, address, callIndex, 27 + (yParity ?? 0), r, s],
      });
      refetchSeq();
      setApiResult(`🤖 AI 推理结果 #${Number(callIndex) + 1}: "agent 零 gas 签名授权，服务商代付上链 —— 这就是 x402"`);
    }, "402 → 签名授权 → meter() 记账成功，数据已返回");

  return (
    <div className="card bg-base-200 border border-secondary/30">
      <div className="card-body gap-3">
        <h2 className="card-title">🎫 按次付费订阅</h2>
        <p className="text-xs text-base-content/60 -mt-2">x402 流程：请求 → 402 Payment Required → 链上扣费 → 返回数据</p>

        <div className="flex gap-2 flex-wrap">
          <button
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={() => act(() => writeContractAsync({ functionName: "createPlan", args: [parseEther(price)] }), `服务已挂单：${price} MON/次`)}
          >
            挂单 {price} MON/次
          </button>
          <label className="input input-sm flex items-center gap-1">
            预付
            <input className="w-12" value={calls} onChange={e => setCalls(e.target.value)} />次
          </label>
          <button
            className="btn btn-sm btn-secondary"
            disabled={busy || latestPlan === 0n}
            onClick={() =>
              act(
                () =>
                  writeContractAsync({
                    functionName: "subscribe",
                    args: [latestPlan, BigInt(calls)],
                    value: parseEther(price) * BigInt(calls),
                  }),
                `已预付 ${calls} 次调用`,
              )
            }
          >
            订阅
          </button>
        </div>

        {latestPlan > 0n && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm flex flex-col gap-2">
            <div className="flex justify-between">
              <span>Plan #{latestPlan.toString()}</span>
              <span>
                我的剩余次数: <b className="text-secondary">{myCredits?.toString() ?? "0"}</b>
              </span>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <button className="btn btn-sm btn-accent" disabled={busy} onClick={callPaidApi}>
                ⚡ 调用付费 API
              </button>
              <span className="text-xs text-base-content/50">服务商待提现: {formatEther(myPending ?? 0n)} MON</span>
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy || !myPending || myPending === 0n}
                onClick={() => act(() => writeContractAsync({ functionName: "withdrawProvider" }), "服务商已提现")}
              >
                提现
              </button>
            </div>
            {apiResult && <div className="alert alert-success py-2 text-xs">{apiResult}</div>}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * EscrowCard —— Escrow 结算：锁款 → 交付凭证 → 释放 / 超时退款
 */
export const EscrowCard = () => {
  const { address } = useAccount();
  const [amount, setAmount] = useState("0.005");
  const [busy, setBusy] = useState(false);

  const { data: escrowCount } = useScaffoldReadContract({ contractName: "AgentPayVault", functionName: "escrowCount" });
  const latestId = escrowCount && escrowCount > 0n ? escrowCount : 0n;

  const { data: escrowRaw, refetch } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "escrows",
    args: [latestId],
  });

  const e = escrowRaw as unknown as
    | { payer: string; payee: string; amount: bigint; deliveryHash: string; deadline: bigint; status: number }
    | undefined;
  const STATUS = ["🔒 已锁定", "📦 已交付", "✅ 已释放", "↩️ 已退款"];

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault" });

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!address) return notification.error("请先连接钱包");
    setBusy(true);
    try {
      await fn();
      notification.success(okMsg);
      refetch();
    } catch (err) {
      console.error(err);
      notification.error("交易失败，看控制台");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card bg-base-200 border border-accent/30">
      <div className="card-body gap-3">
        <h2 className="card-title">🤝 Escrow 结算</h2>
        <p className="text-xs text-base-content/60 -mt-2">锁款担保 → 交付凭证哈希上链 → 确认释放 / 超时自动退款</p>

        <div className="flex gap-2 flex-wrap items-center">
          <label className="input input-sm flex items-center gap-1">
            金额
            <input className="w-16" value={amount} onChange={ev => setAmount(ev.target.value)} />
            MON
          </label>
          <button
            className="btn btn-sm btn-accent"
            disabled={busy}
            onClick={() =>
              act(
                () =>
                  writeContractAsync({
                    functionName: "lockEscrow",
                    args: [address!, "0x0000000000000000000000000000000000000000000000000000000000000000", 3600n, zeroAddress],
                    value: parseEther(amount),
                  }),
                "资金已锁定进 Escrow",
              )
            }
          >
            锁定资金
          </button>
        </div>

        {latestId > 0n && e && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm flex flex-col gap-2">
            <div className="flex justify-between">
              <span>Escrow #{latestId.toString()}</span>
              <span className="badge badge-accent">{STATUS[e.status] ?? e.status}</span>
            </div>
            <div>金额: {formatEther(e.amount)} MON</div>
            <div className="flex gap-2 flex-wrap">
              <button
                className="btn btn-xs btn-info"
                disabled={busy || e.status !== 0}
                onClick={() =>
                  act(
                    () =>
                      writeContractAsync({
                        functionName: "deliver",
                        args: [latestId, `0x${Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`],
                      }),
                    "交付凭证已上链",
                  )
                }
              >
                服务商提交交付
              </button>
              <button
                className="btn btn-xs btn-success"
                disabled={busy || e.status !== 1}
                onClick={() => act(() => writeContractAsync({ functionName: "release", args: [latestId] }), "资金已释放给服务商")}
              >
                确认释放
              </button>
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy || e.status !== 0}
                onClick={() => act(() => writeContractAsync({ functionName: "refundExpired", args: [latestId] }), "已退款")}
              >
                超时退款
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
