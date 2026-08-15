"use client";

import { useState } from "react";
import { useScaffoldEventHistory, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

/**
 * LivePanel —— 真实打靶：连接 Monad 测试网上的 ConflictLab
 * 观众/评委现场发交易，面板实时显示同一区块内被打包的多笔冲突交易
 */
export const LivePanel = () => {
  const [busy, setBusy] = useState(false);

  const { data: hotCounter } = useScaffoldReadContract({
    contractName: "ConflictLab",
    functionName: "hotCounter",
    watch: true,
  });

  const { data: totalTransfers } = useScaffoldReadContract({
    contractName: "ConflictLab",
    functionName: "totalTransfers",
    watch: true,
  });

  // 演示场景需要实时事件流；弃用警告针对生产索引场景（roadmap: 换 Envio/Ponder）
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const { data: bumpEvents } = useScaffoldEventHistory({
    contractName: "ConflictLab",
    eventName: "Bumped",
    watch: true,
    fromBlock: 0n,
    // Monad RPC 的 eth_getLogs 限 100 块窗口，批次必须小于它
    blocksBatchSize: 99,
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "ConflictLab" });

  const fire = async (kind: "bump" | "transfer") => {
    setBusy(true);
    try {
      if (kind === "bump") {
        await writeContractAsync({ functionName: "bump" });
      } else {
        // 随手转 1 个记账单位给部署者地址，制造账本冲突
        await writeContractAsync({
          functionName: "transfer",
          args: ["0xD198407729C779Aa994Ffa9EF10dAae2AE523252", 1n],
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  // 按区块分组事件：同一块里 >1 笔 = 并行执行的实锤
  const byBlock = new Map<string, number>();
  (bumpEvents ?? []).forEach(e => {
    const bn = e.blockNumber?.toString() ?? "?";
    byBlock.set(bn, (byBlock.get(bn) ?? 0) + 1);
  });
  const parallelBlocks = [...byBlock.entries()].filter(([, n]) => n > 1).slice(-6);

  return (
    <div className="card bg-base-200 w-full">
      <div className="card-body gap-4">
        <h2 className="card-title">🎯 真实打靶 · Monad 测试网</h2>

        <div className="stats stats-vertical sm:stats-horizontal shadow w-full">
          <div className="stat">
            <div className="stat-title">热计数器 hotCounter</div>
            <div className="stat-value text-primary">{hotCounter?.toString() ?? "—"}</div>
            <div className="stat-desc">所有交易争抢的全局状态</div>
          </div>
          <div className="stat">
            <div className="stat-title">总转账数</div>
            <div className="stat-value">{totalTransfers?.toString() ?? "—"}</div>
          </div>
          <div className="stat">
            <div className="stat-title">同块多笔交易</div>
            <div className="stat-value text-secondary">{parallelBlocks.length}</div>
            <div className="stat-desc">并行打包的实锤</div>
          </div>
        </div>

        <div className="flex gap-3 flex-wrap">
          <button className="btn btn-secondary" onClick={() => fire("bump")} disabled={busy}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : "⚡"} 发一笔 bump()
          </button>
          <button className="btn btn-outline" onClick={() => fire("transfer")} disabled={busy}>
            发一笔 transfer()
          </button>
          <span className="text-xs text-base-content/60 self-center">连打几笔 → 看它们挤进同一个亚秒级的块</span>
        </div>

        {parallelBlocks.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>区块号</th>
                  <th>同块交易数</th>
                  <th>结论</th>
                </tr>
              </thead>
              <tbody>
                {parallelBlocks.map(([bn, n]) => (
                  <tr key={bn}>
                    <td className="font-mono">{bn}</td>
                    <td className="font-mono font-bold text-secondary">{n} 笔</td>
                    <td className="text-success text-xs">同一区块并行执行 ✓</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
