// 多 agent 并发压测：3 个 agent 同时向 ConflictLab 各发 4 笔 bump()
// 全部争抢 hotCounter 热状态 → 观察多少笔挤进同一个亚秒区块
// 用法：node scripts/burst.mjs   （agent 钱包需先有 MON，私钥在 ../hardhat/.env.agents）
import { readFileSync } from "fs";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const CONFLICT_LAB = "0xe4ef366c5c5ad646c8c044a3ab579b32c1cc447e";
const abi = parseAbi(["function bump()", "function hotCounter() view returns (uint256)"]);
const RPC = "https://testnet-rpc.monad.xyz";

const env = readFileSync("../hardhat/.env.agents", "utf8");
const keys = [...env.matchAll(/AGENT_\d_PK=(0x[0-9a-fA-F]+)/g)].map(m => m[1]);

const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
const TXS_PER_AGENT = 4;

console.log(`🔥 ${keys.length} 个 agent × ${TXS_PER_AGENT} 笔 bump() 并发开火…\n`);

const t0 = Date.now();
const allHashes = await Promise.all(
  keys.map(async pk => {
    const account = privateKeyToAccount(pk);
    const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC) });
    const baseNonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
    const hashes = [];
    for (let i = 0; i < TXS_PER_AGENT; i++) {
      hashes.push(
        await wallet.writeContract({
          address: CONFLICT_LAB,
          abi,
          functionName: "bump",
          nonce: baseNonce + i,
        }),
      );
    }
    return { agent: account.address, hashes };
  }),
);

console.log(`⏱ ${allHashes.flatMap(a => a.hashes).length} 笔全部发出，耗时 ${Date.now() - t0}ms\n等待打包…\n`);

const receipts = await Promise.all(
  allHashes.flatMap(({ agent, hashes }) =>
    hashes.map(h => pub.waitForTransactionReceipt({ hash: h }).then(r => ({ agent, r }))),
  ),
);

// 按区块分组
const byBlock = new Map();
for (const { agent, r } of receipts) {
  const bn = r.blockNumber.toString();
  if (!byBlock.has(bn)) byBlock.set(bn, []);
  byBlock.get(bn).push({ agent: agent.slice(0, 8), gas: r.gasUsed });
}

console.log("📦 区块分布：");
let sameBlock = 0;
for (const [bn, txs] of [...byBlock.entries()].sort()) {
  const tag = txs.length > 1 ? " ⚡ 并行打包" : "";
  if (txs.length > 1) sameBlock++;
  console.log(`  区块 ${bn}: ${txs.length} 笔${tag}  (${txs.map(t => t.agent + "…").join(", ")})`);
}

const counter = await pub.readContract({ address: CONFLICT_LAB, abi, functionName: "hotCounter" });
console.log(`\n✅ hotCounter = ${counter}（应 = ${receipts.length}，一笔不少 = 冲突全部正确重放）`);
console.log(`⚡ ${sameBlock} 个区块内多笔打包 / 共 ${byBlock.size} 个区块 —— 乐观并行执行的实锤`);
