import Link from "next/link";
import type { NextPage } from "next";
import { EscrowCard, PlanCard, StreamCard } from "~~/components/AgentPayCards";
import { ChannelCard } from "~~/components/ChannelCard";
import { P256Panel } from "~~/components/P256Panel";

const Home: NextPage = () => {
  return (
    <div className="flex flex-col grow items-center px-4 py-10 gap-8 max-w-5xl mx-auto w-full">
      {/* Hero */}
      <div className="text-center pt-6">
        <div className="badge badge-outline border-accent/60 text-accent mb-5 tracking-widest serif">
          MONAD BLITZ · 北京 V2
        </div>
        <h1 className="text-5xl font-bold mb-3 leading-tight">
          AgentPay <span className="ink-accent">Vault</span>
        </h1>
        <p className="text-lg text-base-content/85 serif">AI Agent 经济的微支付结算层 · x402 的合约补层</p>
        <p className="text-sm text-base-content/55 mt-3 max-w-2xl mx-auto leading-relaxed">
          x402 教 agent 怎么开口谈钱（HTTP 授权层）—— 而钱在链上的账本与保险柜，由这里提供。
          <br />
          三种消费形态，三个合约原语，一行代码切换结算模式。
        </p>
      </div>

      {/* 三个原语标签 */}
      <div className="flex gap-3 flex-wrap justify-center -mt-2">
        <span className="badge badge-lg badge-primary badge-outline">🌊 连续服务 · 流支付</span>
        <span className="badge badge-lg badge-secondary badge-outline">🎫 离散调用 · 按次计量</span>
        <span className="badge badge-lg badge-accent badge-outline">🤝 任务交付 · 乐观托管</span>
      </div>

      {/* 原语卡片 */}
      <StreamCard />
      <ChannelCard />
      <EscrowCard />
      <PlanCard />

      {/* Monad 独占能力 */}
      <P256Panel />

      {/* 并行执行证明 */}
      <div className="card w-full border border-primary/40 bg-gradient-to-r from-primary/15 via-base-200 to-accent/10">
        <div className="card-body py-5 flex-row items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="card-title text-base">🔬 为什么只有 Monad 成立？</h2>
            <p className="text-xs text-base-content/60 mt-1">
              100 个 agent 同时给同一服务商付费 = 热状态冲突。看 Monad 乐观并行执行如何处理 —— 冲突显微镜现场演示
            </p>
          </div>
          <Link href="/lens" className="btn btn-primary btn-sm">
            打开 ParallelLens →
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Home;
