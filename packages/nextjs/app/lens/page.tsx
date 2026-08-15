"use client";

import { useMemo, useState } from "react";
import type { NextPage } from "next";
import { LivePanel } from "~~/components/LivePanel";
import { MONAD101_PRESET, SimTx, TxTrace, runParallelSim } from "~~/utils/parallelSim/engine";

type Phase = "idle" | "parallel" | "committing" | "done";

const ADDR_STYLE: Record<string, string> = {
  Alice: "badge-primary",
  Bob: "badge-secondary",
  Carol: "badge-accent",
  Dave: "badge-info",
  Eve: "badge-warning",
  Frank: "badge-neutral",
};

const ParallelLens: NextPage = () => {
  const [txs] = useState<SimTx[]>(MONAD101_PRESET.txs);
  const snapshot = MONAD101_PRESET.snapshot;
  const [phase, setPhase] = useState<Phase>("idle");
  const [commitIdx, setCommitIdx] = useState(-1);
  const result = useMemo(() => runParallelSim(snapshot, txs), [snapshot, txs]);

  const run = () => {
    setPhase("parallel");
    setCommitIdx(-1);
    // 阶段1：并行执行 1.2s —— 所有车道同时开动
    setTimeout(() => {
      setPhase("committing");
      setCommitIdx(0);
      // 阶段2：逐笔提交，每笔 1s
      txs.forEach((_, i) => {
        setTimeout(
          () => {
            setCommitIdx(i + 1);
            if (i === txs.length - 1) setTimeout(() => setPhase("done"), 900);
          },
          (i + 1) * 1000,
        );
      });
    }, 1200);
  };

  const reset = () => {
    setPhase("idle");
    setCommitIdx(-1);
  };

  const traceOf = (txId: number): TxTrace | undefined => result.traces.find(t => t.txId === txId);
  const isCommittingTx = (i: number) => phase === "committing" && commitIdx === i;
  const isCommittedTx = (i: number) => phase === "done" || (phase === "committing" && commitIdx > i);

  return (
    <div className="flex flex-col grow items-center px-4 py-8 gap-6 max-w-5xl mx-auto w-full">
      {/* 标题区 */}
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-2">
          🔬 Parallel<span className="ink-accent">Lens</span>
        </h1>
        <p className="text-base-content/70">Monad 乐观并行执行 · 状态冲突 · 覆盖重执行 —— 一目了然</p>
      </div>

      {/* 控制区 */}
      <div className="flex gap-3 items-center">
        <button className="btn btn-primary" onClick={run} disabled={phase === "parallel" || phase === "committing"}>
          ▶ 并行执行这一批交易
        </button>
        <button className="btn btn-ghost" onClick={reset}>
          ↺ 重置
        </button>
        {phase === "done" && (
          <span className="badge badge-warning badge-lg">检测到 {result.conflictCount} 笔冲突，已重执行</span>
        )}
      </div>

      {/* 初始快照 */}
      <div className="card bg-base-200 w-full">
        <div className="card-body py-4">
          <h2 className="card-title text-sm">统一快照（所有交易的共同输入）</h2>
          <div className="flex gap-4 flex-wrap">
            {Object.entries(snapshot).map(([addr, bal]) => (
              <div key={addr} className="flex items-center gap-2">
                <span className={`badge ${ADDR_STYLE[addr] ?? "badge-neutral"}`}>{addr}</span>
                <span className="font-mono font-bold">${bal}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 并行车道 */}
      <div className="w-full flex flex-col gap-3">
        {txs.map((tx, i) => {
          const trace = traceOf(tx.id);
          const showOptimistic = phase !== "idle";
          const committing = isCommittingTx(i);
          const committed = isCommittedTx(i);
          const conflict = committed && trace?.conflict;
          return (
            <div
              key={tx.id}
              className={`card border-2 transition-all duration-300 ${
                committing
                  ? "border-warning shadow-lg shadow-warning/30"
                  : conflict
                    ? "border-error"
                    : committed
                      ? "border-success"
                      : "border-base-300"
              }`}
            >
              <div className="card-body py-3 px-4 flex-row items-center gap-4 flex-wrap">
                <div className="w-24 font-bold">
                  TX#{tx.id} {committing && <span className="loading loading-spinner loading-xs text-warning" />}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`badge ${ADDR_STYLE[tx.from] ?? "badge-neutral"}`}>{tx.from}</span>→
                  <span className={`badge ${ADDR_STYLE[tx.to] ?? "badge-neutral"}`}>{tx.to}</span>
                  <span className="font-mono">${tx.amount}</span>
                </div>
                {/* 车道动画 */}
                <div className="flex-1 min-w-40 h-2 bg-base-300 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-1000 ${
                      conflict ? "bg-error" : committed ? "bg-success" : "bg-primary"
                    }`}
                    style={{ width: phase === "idle" ? "0%" : showOptimistic ? "100%" : "0%" }}
                  />
                </div>
                <div className="w-56 text-sm font-mono">
                  {!showOptimistic && <span className="text-base-content/40">等待发车</span>}
                  {showOptimistic && !committed && trace && (
                    <span className="text-primary">
                      并行输出: {tx.from}=${trace.optimisticOutput[tx.from]}
                    </span>
                  )}
                  {conflict && trace && (
                    <span className="text-error font-bold">
                      ⚡ 冲突！{tx.from} 乐观值 ${trace.optimisticOutput[tx.from]} 已过期 → 重执行
                    </span>
                  )}
                  {committed && !conflict && <span className="text-success">✓ 无冲突，直接提交</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 最终状态对比 */}
      {phase === "done" && (
        <div className="card bg-base-200 w-full">
          <div className="card-body py-4">
            <h2 className="card-title text-sm">已提交状态版本区（最终结果）</h2>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>账户</th>
                    <th>快照</th>
                    <th>若全部按乐观输出（错误）</th>
                    <th>覆盖重执行后（正确）</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(snapshot).map(addr => {
                    // 只看【写集包含该地址】的交易的乐观输出（乐观输出是整本拷贝，须按写集过滤）
                    const optimisticWrong = result.traces.reduce((acc, t) => {
                      const tx = txs.find(x => x.id === t.txId);
                      return tx && (tx.from === addr || tx.to === addr) ? t.optimisticOutput[addr] : acc;
                    }, snapshot[addr]);
                    const correct = result.finalState[addr];
                    const mismatch = optimisticWrong !== correct;
                    return (
                      <tr key={addr}>
                        <td>
                          <span className={`badge ${ADDR_STYLE[addr] ?? "badge-neutral"}`}>{addr}</span>
                        </td>
                        <td className="font-mono">${snapshot[addr]}</td>
                        <td className={`font-mono ${mismatch ? "text-error line-through" : ""}`}>${optimisticWrong}</td>
                        <td className="font-mono font-bold text-success">${correct}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-base-content/60 mt-2">
              TX#3 并行执行时读到 Alice=$1000 的旧快照，输出 $900；提交时发现 Alice 已被 TX#1 改为 $900 →
              用已提交状态覆盖快照后重执行，得到正确结果 $800。这就是 Monad「乐观并行执行 + 冲突重执行」的全过程。
            </p>
          </div>
        </div>
      )}

      {/* 真实链上打靶面板 */}
      <LivePanel />
    </div>
  );
};

export default ParallelLens;
