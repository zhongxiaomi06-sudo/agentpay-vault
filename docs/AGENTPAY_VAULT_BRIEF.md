# AgentPay Vault —— 完整开发文档 · 问题点解读 · 竞品调研对比

> 版本：2026-08-15（Monad Blitz 北京 V2 提交版）
> 仓库：`~/Web3/parallel-lens`（Scaffold-ETH 2 Hardhat 版）
> 定位一句话：**x402/MPP 教 agent 怎么开口谈钱（HTTP 授权层），AgentPay Vault 是钱在 Monad 链上的账本和保险柜（结算状态机）。**

---

## 目录

1. 项目定位
2. 系统架构与模块清单
3. 核心机制设计（含真实接口）
4. Monad 原生性验证对账单
5. 问题点解读（代码级 + 机制级 + 口径修正）
6. 竞品调研与对比（带来源）
7. 差异化定位与答辩话术库
8. 风险与 Roadmap
9. 附录：网络参数 / 账户 / 命令

---

## 1. 项目定位

| 维度 | 内容 |
|---|---|
| 是什么 | AI agent 经济的链上结算层：流支付（时间）+ 按次计量（用量）+ 托管（任务）三种粒度，一个合约 |
| 解决的真问题 | ① 互不信任主体间的公平交换（无仲裁最小机制）② $0.0001–$0.1 死亡价格带服务在卡体系下根本无法存在 ③ Monad 需要"什么应用非 10K TPS 不可"的实证 |
| 不是什么 | 不是又一个支付协议（不发明轮子）；不是 agent 零工市场（那是 PrismSettle 的应用层定位） |
| 与 x402/MPP 关系 | 互补：它们是客户端/授权层，我们是它们 settle 到 Monad 时的链上资金状态机。ChannelVault 即 MPP Session 的 Monad 原生合约实现 |

## 2. 系统架构与模块清单

```
┌─ packages/hardhat/contracts ─────────────────────────────┐
│ AgentPayVault.sol  (11.9K)  流支付 + 按次 meter + Escrow  │
│ ChannelVault.sol   (4.0K)   EIP-712 累计 voucher 通道     │
│ ConflictLab.sol    (1.8K)   并行冲突实验台（热状态）       │
│ YourContract.sol   (2.9K)   ⚠️ 模板残留，提交前删除        │
└──────────────────────────────────────────────────────────┘
┌─ packages/nextjs/app ────────────────────────────────────┐
│ /        产品主页：StreamCard / PlanCard(meter 流程) /     │
│          ChannelCard / EscrowCard / P256Panel / LivePanel │
│ /lens    ParallelLens 并行执行可视化                      │
└──────────────────────────────────────────────────────────┘
中间件：Next.js /api/paid-data —— 真 402 状态码路由（非前端模拟）
```

- 部署账户（一次性）：`0xD198407729C779Aa994Ffa9EF10dAae2AE523252`，私钥在 `packages/hardhat/.env`
- 部署命令：`yarn deploy --network monadTestnet` → `yarn vercel:yolo --prod`
- 支付媒介：**测试网 demo 用原生 MON**（payable），主网版切 USDC（SafeERC20）

## 3. 核心机制设计

### 3.1 流支付 Stream（时间驱动 —— 全场独有）

```
openStream(payee, ratePerSecond) payable   // agent 预付押金
earned(id) → uint256                       // 读时结算：(now-start)*rate，无需 keeper
solvent(id) → bool                         // 中间件一次 eth_call 放行
withdrawStream(id)                          // 服务商随用随取已归属部分
closeStream(id)                             // 先结归属给服务商，再退余额给 agent
```

- 关键性质：无循环、无 cron、数学自动收敛、无清算角色（对比 Superfluid 依赖 keeper 清算）
- `closeStream` 顺序：先算 `outstanding` 给服务商再退 `refund`——顺序反了就是资金漏洞

### 3.2 按次计量 Plan / meter（用量驱动）

```
createPlan(pricePerCall)                    // 服务商挂单（链上服务市场）
subscribe(planId, calls) payable            // agent 预付 N 次额度
call(planId)                                // agent 自助调用（自付 gas）
meter(planId, agent, callIndex, v, r, s)    // x402 模式：agent 离线签 MeterAuth，服务商代付 gas 上链
withdrawProvider()                          // 服务商提现（pull over push）
```

- EIP-712 `MeterAuth(planId, agent, callIndex)`，domain 绑死 chainId + 合约地址
- `callIndex` 严格等于链上 `callSeq` 递增——防重放、防跳号
- `pending[provider]` 即热状态：并发写争抢点，Monad 乐观并行 + 重放保证正确（演示叙事核心）
- `protocolFeeBps`（默认 0，上限 5%）：被问商业模式时的现成答案

### 3.3 Escrow（任务托管）

```
lockEscrow(payee, expectedHash, timeoutSecs, arbiter) payable
deliver(id, resultHash)    // 存 keccak256(id, payee, resultHash)，绑定上下文防跨任务重用
release(id)                // agent 链下验证结果哈希匹配后确认释放
refundExpired(id)          // 超时未交付，任何人可触发退款（pull，无"自动"）
```

### 3.4 ChannelVault（通道 —— MPP Session 兼容叙事）

- `Voucher(channelId, cumulativeAmount)`：**cumulativeAmount 单调递增天然是 nonce**，旧 voucher 直接拒绝（`stale voucher`），接口省一个参数
- 可多次 claim，按增量结算；过期后 agent `closeChannel` 取回 `budget - settled`
- 独立 EIP-712 domain（与 AgentPayVault 隔离更干净）
- 一万次调用 = 2 笔链上交易——**注意：这是 Stripe MPP 的原话卖点，只能讲"我们兼容 MPP 语义"，不能讲"我们发明"**

### 3.5 ConflictLab（并行实证）

- `hotCounter` 全局热计数器：每笔 transfer/deposit 都写它 → 故意制造状态冲突
- 用途：N 账户并发转账，测 Monad 乐观并行执行下的冲突率/有效吞吐——**性能声明的第三方实证**
- /lens 页把并行执行、冲突、重放可视化

### 3.6 P256（agent 密钥验签）

- EIP-7951 precompile 在 `0x0100`，**2026-08-15 双网实测**：测试网/主网有效签名返回 1，篡改返回空
- 前端 P256Panel 用 noble-curves 生成 P256 密钥模拟 Secure Enclave，链上 precompile 真验证（不接 WebAuthn，降风险；真 passkey 进 roadmap）
- ⚠️ 口径：P256 是"agent 硬件密钥验签可用性"的验证面板，**不在主结算路径**（结算用 ecrecover）

## 4. Monad 原生性验证对账单

| Monad 特性 | 验证操作 | 状态 |
|---|---|---|
| 并行执行 / 高 TPS | ConflictLab 并发压测热状态 + /lens 可视化 | ✅ |
| 0.3s 块 / 0.6s 终局（MIP-12，2026-07 硬分叉） | 流支付余额条按秒真实变动 | ✅ demo 即证据 |
| P256 precompile（0x0100） | 双网 eth_call 实测 | ✅ |
| 低 gas | **`meter()` gas 实测 → 换算美元/次** | ⚠️ 提交前补这个数字：`forge test --gas-report` 或部署后实测 |

## 5. 问题点解读

### 5.1 代码级（读码发现，按严重度）

| # | 问题 | 位置 | 处置 |
|---|---|---|---|
| P0 | **`expectedHash` 是 dead param**：lockEscrow 接收但从不存储，deliver 也不比对——"期望哈希校验"实际未闭环 | AgentPayVault `lockEscrow` | 要么存储并在 release 前供链下读取比对（写进 README 流程），要么删参数。**评委读码会问** |
| P0 | **Escrow 买方装死漏洞**：服务商交付后 agent 不 release 也不 dispute，无法到期退款（已 Delivered 状态 refundExpired 拒绝）→ 资金卡死，或退化成买方白嫖 | Escrow 段 | 升级乐观托管（claim/dispute/争议窗口），见 5.2；来不及就写 roadmap 并主动讲 |
| P1 | 无 ReentrancyGuard：全部转账用低级 `call`。CEI 顺序基本正确（先更新状态再转账），但 `closeStream` 先转 payee 再转 payer，payee 若为合约有跨函数重入面 | 全部转账点 | 黑客松可接受；答辩口径"已知悉，主网版加 ReentrancyGuard + 改 USDC SafeERC20" |
| P1 | ChannelVault `claim` 是 push 直转，与"pull over push"叙事不一致 | ChannelVault | 话术：通道结算额小、单笔即结；沉淀收入走 pending 提现。或承认并说明取舍 |
| P2 | `claim` 无 expiry 检查：agent 不 close 则 voucher 永久可 claim | ChannelVault | 设计可接受（expiry 仅是 agent 提款门槛），README 写明 |
| P2 | YourContract.sol 模板残留 | contracts/ | 提交前删除，避免评委误读 |
| P3 | 支付媒介是原生 MON 而非 USDC | 全部 payable | 演示简化成立；主网口径：切 USDC + SafeERC20（x402 语义一致） |

### 5.2 机制级（升级方案：乐观托管 Optimistic Escrow）

**痛点**：现有 escrow 只保护买方（超时退款），卖方交付后买方装死即白嫖——无仲裁 escrow 的经典死穴。

**升级**（改动封闭在 escrow 段，~1.5h 合约+测试，0.5h 前端）：

```
deliver(id, resultHash)   // 开启 challengePeriod 争议窗口
release(id)               // 买方确认 → 100% 给服务商（提前终局）
claim(id)                 // 窗口期无人 dispute → 服务商乐观取款 100%
dispute(id)               // 窗口内买方发起 → 50/50 强制 split（双输谢林点）
refundExpired(id)         // deadline 未交付 → 全额退买方（不变）
```

博弈覆盖：买方装死→claim 堵死；服务商交垃圾→dispute 可信威胁；服务商跑路→refund；买方恶意 dispute→最多拿回 50%。

**叙事同构**：Monad 执行层乐观并行（先跑、冲突重放）⇆ 我们结算层乐观托管（先放款、争议惩罚）——"乐观假设 + 事后纠错，换取无协调者的吞吐"。

### 5.3 口径修正（台上别报错）

- 出块 **0.3s**、终局 **0.6s**（MIP-12 后），不是"0.6s 块"
- 测试网 RPC 用 `https://testnet-rpc.monad.xyz`；门户写的 `rpc.testnet.monad.xyz` 已 NXDOMAIN 失效
- "超时自动退款"改口"超时后任何人可触发 refund（pull 模式）"
- USDC 测试币：Circle faucet（faucet.circle.com 选 Monad Testnet）；MON：faucet.monad.xyz / faucet.quicknode.com/monad

## 6. 竞品调研与对比

### 6.1 协议层（巨头战场，2026 年中）

| 协议 | 背后 | 层 | 关键事实 | 我们的关系 |
|---|---|---|---|---|
| x402 | Coinbase→Linux 基金会 | 结算轨 | 1.54 亿笔；**明确无退款/托管**；真实日流水 ~$28K | 我们的上游+宿主 |
| MPP | Stripe+Tempo（2026-03 上线） | 会话 | **链上 escrow+链下累计 voucher+末张结算=2 笔交易**，100+ 厂商 | ChannelVault 同构——讲兼容不讲发明 |
| AP2 | Google→FIDO | 授权 | 不结算、不托管 | 授权层可叠加 |
| ACP | Stripe+OpenAI | 结账 | OpenAI 2026-03 已关聊天内结账 | 场景不同（人在场） |
| Skyfire | — | 钱包基建 | KYA 企业身份 | 我们 P256 是更底层的 KYA 原语 |

### 6.2 机制谱系（乐观托管的"真实机制"考证）

| 先例 | 机制 | 引用价值 |
|---|---|---|
| ASW 乐观公平交换（Asokan 等, ACM CCS 1997, [论文](https://www.shoup.net/papers/fex.pdf)） | 诚实时 TTP 零参与，争议才唤醒 | 学术血统，28 年 |
| Bisq（[争议机制](https://bisq.wiki/Dispute_Resolution_in_Bisq_1)） | 双方互押保证金 + 时间锁烧毁全部资金（MAD） | 生产级对称惩罚先例；社区已知[勒索/抵押不足辩论](https://bisq.community/t/i-cant-quite-understand-how-deposits-can-be-so-low/11551) |
| UMA 乐观预言机（[官方文档](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)） | 断言+押注+争议窗口，99.8% 无争议通过（Polymarket 规模） | "乐观假设"生产验证 |

**判定：乐观争议窗口不是发明；我们的创新在"彻底移除仲裁者 + 与流支付复合（渐变释放）+ 用在 agent 结算"这个组合。讲谱系+取舍，别讲发明。**

### 6.3 同场竞品（Monad Playground 展示页实读）

| 项目 | 机制 | 强度 | 我们的错位 |
|---|---|---|---|
| [PrismSettle #335](https://mojo.devnads.com/projects/335) | escrow+**人工仲裁**（败方付仲裁费）+256 分片声誉+x402+3 个 DeepSeek agent 现场谈判翻案 | ★★★★ | 它是应用层零工市场；我们零仲裁者零抵押（更轻）；它有声誉我们没有 |
| [Bonded Agent #347](https://mojo.devnads.com/projects/347) | **卖方履约保证金**：差额自动从押金补足，用户本金零损失；真 AMM 真实滑点演示；12/12 测试；内置 Moss 管线 | ★★★★ | 它押卖方抵押（资本效率低）；我们不押；传统金融"履约保函"叙事它占了 |
| ReviewPool #348 | PR 赏金托管支付 | ★★ | 单场景 |
| Mindmark #340 | 锁定预算+验收+结算 AI 任务 | ★★ | 单场景 |
| 其余 | 游戏×3、钱包工具×3、信誉×2、意图守卫×2 等 | — | 无结算层撞车 |

### 6.4 争议解决光谱（答辩核弹页）

```
保护力度 →
Bonded Agent      PrismSettle        AgentPay 乐观托管      裸 x402
卖方超额抵押      仲裁者在线          零第三方零抵押         无救济
本金零损失        败方付仲裁费        极端各损 50%          交付即终局
←——— 资本效率 / 无许可 / 机器速度 ———→
```

高频小额 agent 交易押不起保证金、等不起仲裁——"轻"是这个价格带的正确取舍。

## 7. 差异化定位与答辩话术库

**三个真优势（有证据）**：
1. **时间驱动结算原语**——全场无人有；MPP/x402 全是用量/次数驱动，Superfluid 靠 keeper 且不为 agent 设计
2. **并行实测**——ConflictLab 是 Monad 性能声明的第三方实证，24 个项目没人做
3. **P256 实测**——双网验证，全场没人碰 precompile

**Q&A 速查**：
- 解决什么：x402 管"能不能付"，我们管"按什么粒度结算、钱在链上怎么管"；公平交换+死亡价格带+Monad 性能对账单
- 并行冲突怎么解：协议层乐观重放兜底正确性；合约层 slot 隔离+pull 聚合；业务层 voucher 单调递增=交换律，任意顺序收敛
- 为什么必须 Monad：10K TPS 扛并发、0.3s 块让流式可见、低 gas 让按次记账成立、P256 独占——四特性用满四个
- 商业模式：protocolFeeBps（结算抽成）+ 被生态收编为参考实现
- 金句："支付是动作，结算是制度。""Stripe 和 Coinbase 在争授权标准，但授权到链上那一刻都需要结算状态机——Monad 还没有，我们就是。"

## 8. 风险与 Roadmap

- 风险：需求侧（agent 买方）今天真实体量极小（x402 日流水 $28K）；近期真实客户是**卖基础设施的服务商**（RPC/数据 API 按量计费）
- Roadmap：乐观托管全量版（可选买方押金，防勒索攻击）→ 渐变托管（时间×任务复合释放）→ arbiter hook 激活 → 声誉数据沉淀（dispute 事件即声誉原料）→ 真 WebAuthn passkey → USDC 主网版

## 9. 附录

- 测试网：Chain ID **10143**，RPC `https://testnet-rpc.monad.xyz`，浏览器 testnet.monadscan.com
- 主网：Chain ID **143**，RPC `https://rpc.monad.xyz`
- Precompiles：0x01–0x11（Fusaka 全量）+ **0x0100 P256** + 0x1000 staking + 0x1001 reserve balance
- 部署账户：`0xD198407729C779Aa994Ffa9EF10dAae2AE523252`
- 提交：MOJO 平台（mojo.devnads.com），截止 18:30（Notion）/ 19:00（现场讲稿）
- 命令：`yarn deploy --network monadTestnet` / `yarn verify --network monadTestnet` / `yarn vercel:yolo --prod`
