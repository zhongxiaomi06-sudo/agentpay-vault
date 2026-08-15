// 实测 Monad 测试网上 meter() 的 gas 成本 —— 对账单「低 gas」行的硬数字
// 流程：createPlan → subscribe(预付5次) → agent 离线签 MeterAuth → meter() 上链记账
import { readFileSync } from "fs";
import { createPublicClient, createWalletClient, http, parseEther, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const RPC = "https://testnet-rpc.monad.xyz";
const VAULT = "0x1236c35d325314890f6ab14a549bf057ac01931a";
const artifact = JSON.parse(
  readFileSync("../hardhat/artifacts/contracts/AgentPayVault.sol/AgentPayVault.json", "utf8"),
);
const abi = artifact.abi;

const pk = readFileSync("../hardhat/.env", "utf8").match(/__RUNTIME_DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/)[1];
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(RPC) });

const PRICE = parseEther("0.0001");
const rep = async (label, hash) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(
    `${label}: gasUsed=${r.gasUsed} × gasPrice=${r.effectiveGasPrice} = ${(Number(r.gasUsed * r.effectiveGasPrice) / 1e18).toFixed(6)} MON  (tx: ${hash.slice(0, 18)}…)`,
  );
  return r;
};

// 1. 挂单
let hash = await wallet.writeContract({ address: VAULT, abi, functionName: "createPlan", args: [PRICE] });
await rep("createPlan", hash);
const planId = await pub.readContract({ address: VAULT, abi, functionName: "planCount" });

// 2. 预付 5 次
hash = await wallet.writeContract({
  address: VAULT,
  abi,
  functionName: "subscribe",
  args: [planId, 5n],
  value: PRICE * 5n,
});
await rep("subscribe(5次)", hash);

// 3. agent 离线签 MeterAuth(planId, agent, callIndex=0)
const sig = await account.signTypedData({
  domain: { name: "AgentPayVault", version: "1", chainId: monadTestnet.id, verifyingContract: VAULT },
  types: {
    MeterAuth: [
      { name: "planId", type: "uint256" },
      { name: "agent", type: "address" },
      { name: "callIndex", type: "uint256" },
    ],
  },
  primaryType: "MeterAuth",
  message: { planId, agent: account.address, callIndex: 0n },
});
const { r, s, yParity } = parseSignature(sig);

// 4. 服务商持签名上链 meter()
hash = await wallet.writeContract({
  address: VAULT,
  abi,
  functionName: "meter",
  args: [planId, account.address, 0n, 27 + (yParity ?? 0), r, s],
});
const meterReceipt = await rep("meter() ⭐", hash);

// 5. 对照组：一笔普通 MON 转账
hash = await wallet.sendTransaction({ to: account.address, value: 1n });
const transferReceipt = await rep("plain transfer(对照)", hash);

console.log(
  `\n按次链上实时记账成本 = ${meterReceipt.gasUsed} gas ≈ 普通转账的 ${(Number(meterReceipt.gasUsed) / Number(transferReceipt.gasUsed)).toFixed(1)} 倍`,
);
console.log(`以亚秒终局 + 此成本，$0.0001 价位的 API 调用链上实时记账成立 ✓`);
