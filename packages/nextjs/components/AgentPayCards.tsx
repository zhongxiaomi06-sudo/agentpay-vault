"use client";

import { useEffect, useState } from "react";
import { formatEther, keccak256, parseEther, parseSignature, toBytes, zeroAddress } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { useDeployedContractInfo, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import {
  getFriendlyTransactionError,
  getReceiptEventArg,
  isExpectedTransactionError,
  notification,
} from "~~/utils/scaffold-eth";
import { structAt } from "~~/utils/scaffold-eth/structAt";

type StreamStruct = {
  payer: string;
  payee: string;
  deposit: bigint;
  ratePerSecond: bigint;
  start: bigint;
  withdrawn: bigint;
  active: boolean;
};
const STREAM_KEYS = ["payer", "payee", "deposit", "ratePerSecond", "start", "withdrawn", "active"] as const;

type EscrowStruct = {
  payer: string;
  payee: string;
  amount: bigint;
  expectedHash: string;
  deliveryHash: string;
  deadline: bigint;
  challengeDeadline: bigint;
  challengePeriod: bigint;
  status: number;
  arbiter: string;
};
const ESCROW_KEYS = [
  "payer",
  "payee",
  "amount",
  "expectedHash",
  "deliveryHash",
  "deadline",
  "challengeDeadline",
  "challengePeriod",
  "status",
  "arbiter",
] as const;

/**
 * StreamCard —— 流支付金库：按秒流式付费，余额实时流动
 */
export const StreamCard = () => {
  const { address } = useAccount();
  const [rate, setRate] = useState("0.00001"); // MON/秒
  const [deposit, setDeposit] = useState("0.01"); // 总押金 MON
  const [busy, setBusy] = useState(false);
  const [streamId, setStreamId] = useState(0n);
  const [nowSec, setNowSec] = useState(0); // 每秒刷新驱动余额流动（effect 内取时，满足 React 渲染纯度）

  useEffect(() => {
    const update = () => setNowSec(Math.floor(Date.now() / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  const { data: streamRaw, refetch } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "streams",
    args: [streamId],
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault", disableSimulate: true });
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "AgentPayVault" });

  // viem 返回 struct 为位置数组，用 structAt 归一化
  const s = structAt<StreamStruct>(streamRaw, STREAM_KEYS);
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
      await refetch();
    } catch (e) {
      if (!isExpectedTransactionError(e)) console.error(e);
      notification.error(getFriendlyTransactionError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card relative">
      <span className="absolute right-5 top-5 size-2.5 rounded-full bg-primary" />
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
              act(async () => {
                if (!vaultInfo) throw new Error("合约信息尚未就绪");
                let createdId: bigint | undefined;
                await writeContractAsync(
                  {
                    functionName: "openStream",
                    args: [address!, parseEther(rate)],
                    value: parseEther(deposit),
                  },
                  {
                    onBlockConfirmation: receipt => {
                      createdId = getReceiptEventArg<bigint>(receipt, vaultInfo.abi, "StreamOpened", "id");
                    },
                  },
                );
                if (!createdId) throw new Error("交易已确认，但未读取到 Stream ID");
                setStreamId(createdId);
              }, "金库已开启，开始流式计费！")
            }
          >
            开启金库
          </button>
        </div>

        {streamId > 0n && s && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm">
            <div className="flex justify-between">
              <span>Stream #{streamId.toString()}</span>
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
                onClick={() =>
                  act(() => writeContractAsync({ functionName: "withdrawStream", args: [streamId] }), "服务商已提现")
                }
              >
                服务商提现
              </button>
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy || !active}
                onClick={() =>
                  act(
                    () => writeContractAsync({ functionName: "closeStream", args: [streamId] }),
                    "金库已关闭，余额退回",
                  )
                }
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
  const [planId, setPlanId] = useState(0n);

  const { data: myCredits, refetch: refetchCredits } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "credits",
    args: [planId, address],
  });

  const { data: myPending, refetch: refetchPending } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "pending",
    args: [address],
  });

  const { data: myCallSeq, refetch: refetchSeq } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "callSeq",
    args: [planId, address],
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault", disableSimulate: true });
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "AgentPayVault" });
  const { targetNetwork } = useTargetNetwork();
  const { signTypedDataAsync } = useSignTypedData();

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!address) return notification.error("请先连接钱包");
    setBusy(true);
    try {
      await fn();
      notification.success(okMsg);
      await Promise.all([refetchCredits(), refetchSeq(), refetchPending()]);
    } catch (e) {
      if (!isExpectedTransactionError(e)) console.error(e);
      notification.error(getFriendlyTransactionError(e));
    } finally {
      setBusy(false);
    }
  };

  // MeterAuth 演示：签名与计量真实执行；当前由连接钱包提交交易，独立 relayer 是下一步
  const [apiResult, setApiResult] = useState<string | null>(null);
  const callPaidApi = () =>
    act(async () => {
      if (!vaultInfo || !address) throw new Error("合约信息或钱包尚未就绪");
      // 连点时读最新序号，防缓存滞后导致 callIndex 过期 revert
      const { data: freshSeq } = await refetchSeq();
      const callIndex = freshSeq ?? myCallSeq ?? 0n;
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
        message: { planId, agent: address, callIndex },
      });
      const { r, s, yParity } = parseSignature(sig);
      await writeContractAsync({
        functionName: "meter",
        args: [planId, address, callIndex, 27 + (yParity ?? 0), r, s],
      });
      const response = await fetch("/api/paid-data", {
        method: "GET",
        cache: "no-store",
        headers: {
          "x-payment-auth": JSON.stringify({
            planId: planId.toString(),
            agent: address,
            callIndex: callIndex.toString(),
            signature: sig,
          }),
        },
      });
      const paidData = (await response.json()) as { data?: string; error?: string };
      if (!response.ok) throw new Error(paidData.error || `付费接口返回 HTTP ${response.status}`);
      setApiResult(paidData.data || `付费数据 #${Number(callIndex) + 1} 已放行`);
    }, "402 授权通过 → meter() 记账成功");

  return (
    <div className="card relative">
      <span className="absolute right-5 top-5 size-2.5 rounded-full bg-info" />
      <div className="card-body gap-3">
        <h2 className="card-title">🎫 按次付费订阅</h2>
        <p className="text-xs text-base-content/60 -mt-2">自定义 MeterAuth 原型：离线签名 → 链上验签 → 扣减预付额度</p>

        <div className="flex gap-2 flex-wrap">
          <button
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={() =>
              act(async () => {
                if (!vaultInfo) throw new Error("合约信息尚未就绪");
                let createdId: bigint | undefined;
                await writeContractAsync(
                  { functionName: "createPlan", args: [parseEther(price)] },
                  {
                    onBlockConfirmation: receipt => {
                      createdId = getReceiptEventArg<bigint>(receipt, vaultInfo.abi, "PlanCreated", "planId");
                    },
                  },
                );
                if (!createdId) throw new Error("交易已确认，但未读取到 Plan ID");
                setPlanId(createdId);
              }, `服务已挂单：${price} MON/次`)
            }
          >
            挂单 {price} MON/次
          </button>
          <label className="input input-sm flex items-center gap-1">
            预付
            <input className="w-12" value={calls} onChange={e => setCalls(e.target.value)} />次
          </label>
          <button
            className="btn btn-sm btn-secondary"
            disabled={busy || planId === 0n}
            onClick={() =>
              act(
                () =>
                  writeContractAsync({
                    functionName: "subscribe",
                    args: [planId, BigInt(calls)],
                    value: parseEther(price) * BigInt(calls),
                  }),
                `已预付 ${calls} 次调用`,
              )
            }
          >
            订阅
          </button>
        </div>

        {planId > 0n && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm flex flex-col gap-2">
            <div className="flex justify-between">
              <span>Plan #{planId.toString()}</span>
              <span>
                我的剩余次数: <b className="text-secondary">{myCredits?.toString() ?? "0"}</b>
              </span>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <button className="btn btn-sm btn-accent" disabled={busy} onClick={callPaidApi}>
                ⚡ 签名并计量
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
 * EscrowCard —— 乐观托管：锁款 → 交付开争议窗口 → 释放 / 乐观取款 / 争议50/50 / 超时退款
 * 与 Monad 执行层同构：乐观假设 + 事后纠错，换取无协调者的吞吐
 */
export const EscrowCard = () => {
  const { address } = useAccount();
  const [amount, setAmount] = useState("0.005");
  const [busy, setBusy] = useState(false);
  const [escrowId, setEscrowId] = useState(0n);
  const [nowSec, setNowSec] = useState(0); // 争议窗口倒计时（effect 内取时，满足渲染纯度）

  useEffect(() => {
    const update = () => setNowSec(Math.floor(Date.now() / 1000));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  const { data: escrowRaw, refetch } = useScaffoldReadContract({
    contractName: "AgentPayVault",
    functionName: "escrows",
    args: [escrowId],
  });

  const e = structAt<EscrowStruct>(escrowRaw, ESCROW_KEYS);
  const STATUS = ["🔒 已锁定", "📦 已交付·争议窗口", "✅ 已释放/已取款", "↩️ 已退款", "⚖️ 争议 50/50"];

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "AgentPayVault", disableSimulate: true });
  const { data: vaultInfo } = useDeployedContractInfo({ contractName: "AgentPayVault" });

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!address) return notification.error("请先连接钱包");
    setBusy(true);
    try {
      await fn();
      notification.success(okMsg);
      refetch();
    } catch (err) {
      if (!isExpectedTransactionError(err)) console.error(err);
      notification.error(getFriendlyTransactionError(err));
    } finally {
      setBusy(false);
    }
  };

  // 演示用：期望交付物固定为 "agent-task-result-v1"，链下可比对 expectedHash
  const DEMO_RESULT_HASH = keccak256(toBytes("agent-task-result-v1"));
  const windowOpen =
    e && e.status === 1 && e.challengeDeadline > 0n && nowSec > 0 && BigInt(nowSec) <= e.challengeDeadline;

  return (
    <div className="card relative">
      <span className="absolute right-5 top-5 size-2.5 rounded-full bg-accent" />
      <div className="card-body gap-3">
        <h2 className="card-title">🤝 乐观托管 Escrow</h2>
        <p className="text-xs text-base-content/60 -mt-2">
          交付即开争议窗口：买方确认释放 / 窗口过期服务商乐观取款 / 窗口内争议 50/50 / 未交付任何人可触发退款
        </p>

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
              act(async () => {
                if (!vaultInfo) throw new Error("合约信息尚未就绪");
                let createdId: bigint | undefined;
                await writeContractAsync(
                  {
                    functionName: "lockEscrow",
                    args: [address!, DEMO_RESULT_HASH, 600n, 60n, zeroAddress],
                    value: parseEther(amount),
                  },
                  {
                    onBlockConfirmation: receipt => {
                      createdId = getReceiptEventArg<bigint>(receipt, vaultInfo.abi, "EscrowLocked", "id");
                    },
                  },
                );
                if (!createdId) throw new Error("交易已确认，但未读取到 Escrow ID");
                setEscrowId(createdId);
              }, "资金已锁定（交付期 10 分钟 + 争议窗口 60 秒）")
            }
          >
            锁定资金
          </button>
        </div>

        {escrowId > 0n && e && (
          <div className="bg-base-300 rounded-xl p-4 font-mono text-sm flex flex-col gap-2">
            <div className="flex justify-between">
              <span>Escrow #{escrowId.toString()}</span>
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
                        args: [escrowId, DEMO_RESULT_HASH],
                      }),
                    "交付凭证已上链，争议窗口开启（60s）",
                  )
                }
              >
                服务商提交交付
              </button>
              <button
                className="btn btn-xs btn-success"
                disabled={busy || e.status !== 1}
                onClick={() =>
                  act(() => writeContractAsync({ functionName: "release", args: [escrowId] }), "已确认释放 100%")
                }
              >
                买方确认释放
              </button>
              <button
                className="btn btn-xs btn-warning"
                disabled={busy || !windowOpen}
                onClick={() =>
                  act(
                    () => writeContractAsync({ functionName: "dispute", args: [escrowId] }),
                    "争议成立：50/50 强制 split",
                  )
                }
              >
                争议 50/50
              </button>
              <button
                className="btn btn-xs btn-secondary"
                disabled={busy || e.status !== 1 || windowOpen}
                onClick={() =>
                  act(
                    () => writeContractAsync({ functionName: "claim", args: [escrowId] }),
                    "窗口无争议，服务商乐观取款 100%",
                  )
                }
              >
                乐观取款
              </button>
              <button
                className="btn btn-xs btn-ghost"
                disabled={busy || e.status !== 0}
                onClick={() =>
                  act(() => writeContractAsync({ functionName: "refundExpired", args: [escrowId] }), "已退款")
                }
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
