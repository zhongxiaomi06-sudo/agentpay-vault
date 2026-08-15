/**
 * ParallelLens 模拟引擎 —— 复刻 Monad 乐观并行执行的完整流程
 *
 * 流程（对应 Monad101 讲座）：
 * 1. 所有交易从【同一份统一快照】并行出发（相同输入，不同输出）
 * 2. 按区块内顺序向【已提交状态版本区】顺序提交
 * 3. 提交时校验：这笔交易并行执行时读到的值，是否已被前面提交的交易覆盖
 * 4. 若冲突 → 用已提交状态覆盖快照作为新输入，重新执行该交易
 */

export type Address = string;

export type SimTx = {
  id: number;
  from: Address;
  to: Address;
  amount: number;
};

export type Ledger = Record<Address, number>;

export type TxTrace = {
  txId: number;
  /** 并行执行阶段的输出（基于过期快照，可能是错的） */
  optimisticOutput: Ledger;
  /** 提交时是否检测到冲突 */
  conflict: boolean;
  /** 是否发生了重执行 */
  reexecuted: boolean;
  /** 最终生效的输出（重执行后的，或未冲突时的乐观输出） */
  finalOutput: Ledger;
};

export type SimResult = {
  snapshot: Ledger;
  traces: TxTrace[];
  finalState: Ledger;
  conflictCount: number;
};

const applyTx = (state: Ledger, tx: SimTx): Ledger => {
  const next = { ...state };
  next[tx.from] = (next[tx.from] ?? 0) - tx.amount;
  next[tx.to] = (next[tx.to] ?? 0) + tx.amount;
  return next;
};

/** 一笔交易"读"了哪些地址的余额（用于冲突检测的 readSet） */
const readSetOf = (tx: SimTx): Address[] => [tx.from, tx.to];

/** 一笔交易"写"了哪些地址（writeSet）——提交时只能写自己的写集，不能整本覆盖 */
const writeSetOf = (tx: SimTx): Address[] => [tx.from, tx.to];

export function runParallelSim(snapshot: Ledger, txs: SimTx[]): SimResult {
  // ---- 阶段 1: 乐观并行执行 —— 所有交易读同一份快照 ----
  const optimisticOutputs = txs.map(tx => applyTx(snapshot, tx));

  // ---- 阶段 2+3: 按序提交 + 冲突检测 + 必要时重执行 ----
  const committed: Ledger = { ...snapshot };
  const traces: TxTrace[] = [];

  txs.forEach((tx, i) => {
    const optimistic = optimisticOutputs[i];
    // 冲突判定：readSet 里任一地址，已提交状态的值 ≠ 并行执行时读到的快照值
    const conflict = readSetOf(tx).some(addr => (committed[addr] ?? 0) !== (snapshot[addr] ?? 0));

    let finalOutput = optimistic;
    if (conflict) {
      // 重执行：已提交状态覆盖旧快照，作为新输入
      finalOutput = applyTx({ ...snapshot, ...committed }, tx);
    }
    // 将该交易【写集内】的修改写入已提交状态版本区
    for (const addr of writeSetOf(tx)) {
      committed[addr] = finalOutput[addr];
    }

    traces.push({ txId: tx.id, optimisticOutput: optimistic, conflict, reexecuted: conflict, finalOutput });
  });

  return {
    snapshot,
    traces,
    finalState: committed,
    conflictCount: traces.filter(t => t.conflict).length,
  };
}

/** 讲座同款案例：Alice $1000 起始，tx1 与 tx3 都花同一笔钱 → tx3 必须重执行；tx2/tx4 走独立账户对，零冲突 */
export const MONAD101_PRESET: { snapshot: Ledger; txs: SimTx[] } = {
  snapshot: { Alice: 1000, Bob: 0, Carol: 3, Dave: 300, Eve: 50, Frank: 0 },
  txs: [
    { id: 1, from: "Alice", to: "Bob", amount: 100 }, // Alice → Bob $100
    { id: 2, from: "Carol", to: "Dave", amount: 1 }, // 无冲突（Carol/Dave 此前未被触碰）
    { id: 3, from: "Alice", to: "Bob", amount: 100 }, // ⚡ 与 tx1 冲突：并行执行时它以为 Alice 还有 1000
    { id: 4, from: "Eve", to: "Frank", amount: 5 }, // 无冲突（独立账户对）
  ],
};
