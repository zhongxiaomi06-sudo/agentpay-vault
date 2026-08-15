import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, fallback, http, isAddress, isHex } from "viem";
import { monadTestnet } from "viem/chains";

/**
 * /api/paid-data —— x402 风格中间件参考实现（真 402，非前端模拟）
 *
 * 无授权 → 402 + 支付要求
 * 携带 agent 的 MeterAuth EIP-712 签名 → 验签 + 链上确认该序号已经结算 → 200 数据
 * 生产环境由服务商持签名调 meter()；当前演示由连接钱包提交结算交易
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

const preferredRpc =
  process.env.MONAD_RPC_URL || process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://monad-testnet.drpc.org";
const pub = createPublicClient({
  chain: monadTestnet,
  transport: fallback([
    http(preferredRpc),
    http("https://rpc.ankr.com/monad_testnet"),
    http("https://testnet-rpc.monad.xyz"),
  ]),
});

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-payment-auth");

  if (!auth) {
    return json(
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
        hint: "Agent 签 MeterAuth 后先由服务商调用 meter() 结算，再把授权放入 x-payment-auth 头重试",
      },
      402,
    );
  }

  let payload: { planId: string; agent: `0x${string}`; callIndex: string; signature: `0x${string}` };
  try {
    const parsed = JSON.parse(auth) as Record<string, unknown>;
    if (
      typeof parsed.planId !== "string" ||
      typeof parsed.callIndex !== "string" ||
      typeof parsed.agent !== "string" ||
      !isAddress(parsed.agent) ||
      typeof parsed.signature !== "string" ||
      !isHex(parsed.signature)
    ) {
      throw new Error("planId、callIndex、agent 或 signature 格式不正确");
    }
    BigInt(parsed.planId);
    BigInt(parsed.callIndex);
    payload = parsed as typeof payload;
  } catch (e) {
    return json({ error: "x-payment-auth 解析失败", detail: String(e) }, 400);
  }

  const { planId, agent, callIndex, signature } = payload;
  try {
    // 1. 链上校验：callSeq 已前进一位，证明 meter() 已成功结算这次授权。
    const [credits, seq] = await Promise.all([
      pub.readContract({ address: VAULT, abi: ABI, functionName: "credits", args: [BigInt(planId), agent] }),
      pub.readContract({ address: VAULT, abi: ABI, functionName: "callSeq", args: [BigInt(planId), agent] }),
    ]);
    if (BigInt(callIndex) + 1n !== seq) {
      return json({ error: `尚未结算或授权已过期：链上 callSeq=${seq}`, settlement: "rejected" }, 402);
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
      return json({ error: "MeterAuth 签名无效", settlement: "rejected" }, 402);
    }

    // 3. 已结算后放行数据。相同 callIndex 返回同一份数据，重试是幂等的。
    return json({
      data: `🤖 付费数据：agent ${agent.slice(0, 8)}… 第 ${Number(callIndex) + 1} 次调用`,
      settlement: "settled on Monad — MeterAuth verified",
      remainingCredits: credits.toString(),
    });
  } catch (e) {
    console.error("paid-data RPC verification failed", e);
    return json({ error: "Monad RPC 暂时不可用，请稍后重试", detail: String(e) }, 503);
  }
}
