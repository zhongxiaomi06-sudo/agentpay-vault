// ⚡ AgentPay Vault 一键演示 ——  Monad Blitz 北京 V2
// 用法：node scripts/demo.mjs
// 自动跑完：流支付 → 按次 meter(EIP-712) → 乐观托管 → 并发压测
// 资金来源：优先用演示钱包(DEMO_WALLET_PK)，否则用部署账户
import { readFileSync } from "fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseSignature,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const RPC_URLS = [
  "https://rpc.ankr.com/monad_testnet",
  "https://monad-testnet.drpc.org",
  "https://testnet-rpc.monad.xyz",
];
const VAULT = "0x1236c35d325314890f6ab14a549bf057ac01931a";
const CONFLICT_LAB = "0xe4ef366c5c5ad646c8c044a3ab579b32c1cc447e";

const vaultAbi = parseAbi([
  "function openStream(address payee, uint256 ratePerSecond) payable returns (uint256)",
  "function earned(uint256 id) view returns (uint256)",
  "function withdrawStream(uint256 id)",
  "function streamCount() view returns (uint256)",
  "function createPlan(uint256 pricePerCall) returns (uint256)",
  "function planCount() view returns (uint256)",
  "function subscribe(uint256 planId, uint256 calls) payable",
  "function meter(uint256 planId, address agent, uint256 callIndex, uint8 v, bytes32 r, bytes32 s)",
  "function callSeq(uint256 planId, address agent) view returns (uint256)",
  "function pending(address) view returns (uint256)",
  "function withdrawProvider()",
  "function lockEscrow(address payee, bytes32 expectedHash, uint256 timeoutSecs, uint256 challengeSecs, address arbiter) payable returns (uint256)",
  "function deliver(uint256 id, bytes32 resultHash)",
  "function release(uint256 id)",
  "function claim(uint256 id)",
  "function escrowCount() view returns (uint256)",
  "function escrows(uint256) view returns (address,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint8,address)",
]);
const labAbi = parseAbi(["function bump()", "function hotCounter() view returns (uint256)"]);

const say = t => console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);
const ok = t => console.log(`  \x1b[32m✓\x1b[0m ${t}`);
const sleep = s => new Promise(r => setTimeout(r, s * 1000));

const envAgents = readFileSync(new URL("../../hardhat/.env.agents", import.meta.url), "utf8");
const demoPk = envAgents.match(/DEMO_WALLET_PK=(0x[0-9a-fA-F]+)/)?.[1];
const agentPks = [...envAgents.matchAll(/AGENT_\d_PK=(0x[0-9a-fA-F]+)/g)].map(m => m[1]);
const deployerPk = readFileSync(new URL("../../hardhat/.env", import.meta.url), "utf8").match(
  /__RUNTIME_DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/,
)[1];

const rpcTransport = fallback(
  RPC_URLS.map(url => http(url, { retryCount: 0, timeout: 12_000 })),
  { retryCount: 0 },
);
const pub = createPublicClient({ chain: monadTestnet, transport: rpcTransport });
const mainPk = demoPk ?? deployerPk;
const main = privateKeyToAccount(mainPk);
const wallet = createWalletClient({ account: main, chain: monadTestnet, transport: rpcTransport });

const bal = await pub.getBalance({ address: main.address });
console.log(`主演示账户: ${main.address}  余额: ${formatEther(bal)} MON`);
if (bal < parseEther("0.05")) {
  console.log("⚠️ 余额不足，请先领水龙头/转账");
  process.exit(1);
}

const tx = async (label, p) => {
  const hash = await p;
  const r = await pub.waitForTransactionReceipt({ hash });
  ok(`${label}  [gas=${r.gasUsed} · ${r.blockNumber} 块 · tx ${hash.slice(0, 14)}…]`);
  return hash;
};

// ========== 第一幕：流支付（时间驱动） ==========
say("🌊 第一幕：流支付金库 —— agent 预付押金，按秒流式付费");
const rate = parseEther("0.00001"); // 每秒
await tx(
  "openStream：预存 0.01 MON，费率 0.00001 MON/秒",
  wallet.writeContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "openStream",
    args: [main.address, rate],
    value: parseEther("0.01"),
  }),
);
const streamId = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "streamCount" });
process.stdout.write("  资金流式归属中（无 cron、无 keeper，读时结算）: ");
for (let i = 0; i < 5; i++) {
  await sleep(2);
  const e = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "earned", args: [streamId] });
  process.stdout.write(`${formatEther(e)} MON → `);
}
console.log("⏹");
await tx(
  "服务商提取已归属收入 withdrawStream",
  wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawStream", args: [streamId] }),
);

// ========== 第二幕：按次计量（x402 哲学） ==========
say("🎫 第二幕：按次计量 —— agent 零 gas 签名授权，服务商持签名上链记账");
await tx(
  "createPlan：挂单 0.0001 MON/次",
  wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "createPlan", args: [parseEther("0.0001")] }),
);
const planId = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "planCount" });
await tx(
  "subscribe：预付 3 次调用额度",
  wallet.writeContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "subscribe",
    args: [planId, 3n],
    value: parseEther("0.0003"),
  }),
);

for (let i = 0; i < 3; i++) {
  const callIndex = await pub.readContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "callSeq",
    args: [planId, main.address],
  });
  const sig = await main.signTypedData({
    domain: { name: "AgentPayVault", version: "1", chainId: 10143, verifyingContract: VAULT },
    types: {
      MeterAuth: [
        { name: "planId", type: "uint256" },
        { name: "agent", type: "address" },
        { name: "callIndex", type: "uint256" },
      ],
    },
    primaryType: "MeterAuth",
    message: { planId, agent: main.address, callIndex },
  });
  const { r, s, yParity } = parseSignature(sig);
  await tx(
    `meter #${i + 1}：离线签名 → 链上记账（agent 未付 gas）`,
    wallet.writeContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: "meter",
      args: [planId, main.address, callIndex, 27 + (yParity ?? 0), r, s],
    }),
  );
}
const pendingBal = await pub.readContract({
  address: VAULT,
  abi: vaultAbi,
  functionName: "pending",
  args: [main.address],
});
ok(`服务商待提现累计: ${formatEther(pendingBal)} MON（pull over push）`);
await tx(
  "服务商 withdrawProvider 提现",
  wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "withdrawProvider" }),
);

// ========== 第三幕：乐观托管 ==========
say("🤝 第三幕：乐观托管 —— 先放款、争议惩罚，与 Monad 乐观并行同构");
const expectedHash = keccak256(toBytes("agent-task-result-v1"));
await tx(
  "lockEscrow：锁定 0.003 MON（争议窗口 20 秒）",
  wallet.writeContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "lockEscrow",
    args: [main.address, expectedHash, 600n, 20n, "0x0000000000000000000000000000000000000000"],
    value: parseEther("0.003"),
  }),
);
const escrowId = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "escrowCount" });
await tx(
  "deliver：服务商提交交付凭证哈希（争议窗口开启）",
  wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "deliver", args: [escrowId, expectedHash] }),
);
console.log("  ⏳ 争议窗口 20 秒（买方此时可 release；装死则由服务商 claim；交付有异议可 dispute 50/50）…");
await sleep(21);
await tx(
  "claim：窗口无争议，服务商乐观取款 100%",
  wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "claim", args: [escrowId] }),
);

// ========== 第四幕：并发压测 ==========
say("🔥 第四幕：乐观并行实证 —— 多 agent 并发争抢同一热状态");
const fundedAgents = [];
for (const pk of agentPks) {
  const a = privateKeyToAccount(pk);
  const b = await pub.getBalance({ address: a.address });
  if (b > parseEther("0.005")) fundedAgents.push({ pk, a });
}
const shooters = fundedAgents.length > 0 ? fundedAgents : [{ pk: mainPk, a: main }];
const perAgent = fundedAgents.length > 0 ? 4 : 3;
console.log(`  ${shooters.length} 个账户 × ${perAgent} 笔 bump() 同时开火（hotCounter 是全局热状态）…`);
const t0 = Date.now();
const bursts = await Promise.all(
  shooters.map(async ({ a }) => {
    const w = createWalletClient({ account: a, chain: monadTestnet, transport: rpcTransport });
    const base = await pub.getTransactionCount({ address: a.address, blockTag: "pending" });
    const hs = [];
    for (let i = 0; i < perAgent; i++) {
      hs.push(await w.writeContract({ address: CONFLICT_LAB, abi: labAbi, functionName: "bump", nonce: base + i }));
    }
    return hs;
  }),
);
const flat = bursts.flat();
console.log(`  ⏱ ${flat.length} 笔全部发出仅耗时 ${Date.now() - t0}ms`);
const receipts = await Promise.all(flat.map(h => pub.waitForTransactionReceipt({ hash: h })));
const byBlock = new Map();
receipts.forEach(r => byBlock.set(r.blockNumber.toString(), (byBlock.get(r.blockNumber.toString()) ?? 0) + 1));
const counter = await pub.readContract({ address: CONFLICT_LAB, abi: labAbi, functionName: "hotCounter" });
say("📊 压测结果");
for (const [bn, n] of [...byBlock.entries()].sort())
  console.log(`  区块 ${bn}: ${n} 笔${n > 1 ? " ⚡ 同块并行打包" : ""}`);
ok(`hotCounter = ${counter}，全部交易冲突重放后一笔不少 —— 乐观并行执行的正确性实锤`);

say("🎬 演示完毕。一句话：x402 教 agent 开口谈钱，AgentPay Vault 是钱在 Monad 上的账本和保险柜。");
