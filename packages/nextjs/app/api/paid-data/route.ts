import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";

/**
 * /api/paid-data —— x402 风格中间件参考实现（真 402，非前端模拟）
 *
 * 无授权 → 402 + 支付要求
 * 携带 agent 的 MeterAuth EIP-712 签名 → 验签 + 链上查额度/序号 → 200 数据
 * 结算由服务商持签名调 AgentPayVault.meter() 完成（agent 零 gas）
 */

const VAULT = "0x1236c35d325314890f6ab14a549bf057ac01931a" as const;
const ABI = [
  {
    name: "credits",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "callSeq",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const pub = createPublicClient({ chain: monadTestnet, transport: http("https://testnet-rpc.monad.xyz") });

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-payment-auth");

  if (!auth) {
    return NextResponse.json(
      {
        error: "Payment Required",
        accepts: [
          {
            scheme: "meter-eip712",
            network: "monad-testnet",
            chainId: 10143,
            vault: VAULT,
            typedData: {
              domain: { name: "AgentPayVault", version: "1", chainId: 10143, verifyingContract: VAULT },
              types: {
                MeterAuth: [
                  { name: "planId", type: "uint256" },
                  { name: "agent", type: "address" },
                  { name: "callIndex", type: "uint256" },
                ],
              },
            },
          },
        ],
        hint: "Agent 签 MeterAuth(planId, agent, callIndex) 后放入 x-payment-auth 头重试；结算由服务商 meter() 上链",
      },
      { status: 402 },
    );
  }

  try {
    const { planId, agent, callIndex, signature } = JSON.parse(auth);

    // 1. 链上校验：序号必须严格连续（防重放/跳号），且预付额度充足
    const [credits, seq] = await Promise.all([
      pub.readContract({ address: VAULT, abi: ABI, functionName: "credits", args: [BigInt(planId), agent] }),
      pub.readContract({ address: VAULT, abi: ABI, functionName: "callSeq", args: [BigInt(planId), agent] }),
    ]);
    if (BigInt(callIndex) !== seq) {
      return NextResponse.json({ error: `callIndex 不连续：期望 ${seq}`, settlement: "rejected" }, { status: 402 });
    }
    if (credits === 0n) {
      return NextResponse.json({ error: "预付额度不足，请先 subscribe()", settlement: "rejected" }, { status: 402 });
    }

    // 2. EIP-712 验签
    const valid = await pub.verifyTypedData({
      address: agent,
      domain: { name: "AgentPayVault", version: "1", chainId: 10143, verifyingContract: VAULT },
      types: {
        MeterAuth: [
          { name: "planId", type: "uint256" },
          { name: "agent", type: "address" },
          { name: "callIndex", type: "uint256" },
        ],
      },
      primaryType: "MeterAuth",
      message: { planId: BigInt(planId), agent, callIndex: BigInt(callIndex) },
      signature,
    });
    if (!valid) {
      return NextResponse.json({ error: "MeterAuth 签名无效", settlement: "rejected" }, { status: 402 });
    }

    // 3. 放行数据（结算：服务商随时拿此授权调 meter() 上链记账，agent 零 gas）
    return NextResponse.json({
      data: `🤖 付费数据：agent ${agent.slice(0, 8)}… 第 ${Number(callIndex) + 1} 次调用`,
      settlement: "authorized — provider 可调 AgentPayVault.meter() 上链结算",
      remainingCredits: credits.toString(),
    });
  } catch (e) {
    return NextResponse.json({ error: "x-payment-auth 解析失败", detail: String(e) }, { status: 400 });
  }
}
