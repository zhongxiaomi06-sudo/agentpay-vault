import Link from "next/link";
import type { NextPage } from "next";
import { EscrowCard, PlanCard, StreamCard } from "~~/components/AgentPayCards";
import { ChannelCard } from "~~/components/ChannelCard";
import { P256Panel } from "~~/components/P256Panel";

const Home: NextPage = () => {
  return (
    <div className="flex flex-col grow items-center px-4 py-8 gap-6 max-w-5xl mx-auto w-full">
      {/* Hero */}
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-2">⚡ AgentPay Vault</h1>
        <p className="text-lg text-base-content/80">AI Agent 经济的微支付结算层 · x402 的合约补层</p>
        <p className="text-sm text-base-content/60 mt-1 max-w-2xl mx-auto">
          x402 解决了单次调用即时结算，但 agent 经济有三种消费形态：
          <b className="text-primary">连续服务</b> / <b className="text-warning">离散调用</b> /{" "}
          <b className="text-accent">任务交付</b>
          —— 三个合约原语 + 统一中间件，任何 x402 服务端一行代码切换结算模式。
        </p>
      </div>

      {/* 三个原语 */}
      <StreamCard />
      <ChannelCard />
      <EscrowCard />
      <PlanCard />

      {/* Monad 独占能力 */}
      <P256Panel />

      {/* 并行执行证明 */}
      <div className="card bg-base-300 w-full">
        <div className="card-body py-4 flex-row items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="card-title text-sm">🔬 为什么只有 Monad 成立？</h2>
            <p className="text-xs text-base-content/60">
              100 个 agent 同时给同一服务商付费 = 热状态冲突。看 Monad 乐观并行执行如何处理 —— 冲突显微镜现场演示
            </p>
          </div>
          <Link href="/lens" className="btn btn-sm btn-outline btn-primary">
            打开 ParallelLens →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Home;
