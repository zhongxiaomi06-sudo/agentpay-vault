# AgentPay Vault：当前版本产品与路演分析

> 基线：2026-08-15 当前工作树（Monad Testnet）  
> 用途：产品定位、技术真实性、竞品边界、答辩策略  
> 配套路演稿：[ROADSHOW_SCRIPT.md](./ROADSHOW_SCRIPT.md)

## 1. 执行摘要

AgentPay Vault 是面向 AI Agent 与数字服务商的链上结算状态机。它不替代钱包、HTTP 支付协议或服务市场，而是管理支付授权之后的资金关系：钱怎么预付、按什么粒度扣、何时释放、失败后如何退出。

一句话定位：

> **x402 让机器通过 HTTP 发起和结算单次支付；AgentPay Vault 把结算关系扩展到时间、批量调用和任务交付。**

项目只解决三类消费关系：

| 消费关系 | 典型服务                         | 当前结算原语                      |
| -------- | -------------------------------- | --------------------------------- |
| 连续服务 | 长时间推理、Agent 托管、RPC 会话 | Stream 按秒累计                   |
| 离散调用 | 数据 API、模型调用、工具调用     | Meter 逐次记账 / Channel 批量结算 |
| 任务交付 | 报告、代码、研究或自动化结果     | Optimistic Escrow                 |

页面上有四张结算卡，但不是四个平级产品。Meter 和 Channel 是“离散调用”的两种成本模型：前者强调实时状态，后者强调链下聚合。

## 2. 为什么需要这层

官方 x402 流程已经覆盖 `402 → 支付要求 → 签名载荷 → 验证 → 链上结算 → 返回资源`，因此不能再把 x402 简化成“只授权、不结算”。AgentPay 的准确差异不是“我们替 x402 做结算”，而是：

- x402 的核心抽象是一次 HTTP 资源请求的一次支付；
- Agent 服务还存在持续计费、成千上万次会话调用、交付后付款等长期资金关系；
- AgentPay 用合约状态机表达这些跨请求、跨时间的关系；
- `/api/paid-data` 展示如何把 HTTP 支付挑战接到自定义 Meter 授权上。

官方参考：

- [Coinbase：How x402 Works](https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works)
- [Coinbase：x402 v2 Migration Guide](https://docs.cdp.coinbase.com/x402/migration-guide)
- [Tempo：Machine Payments / MPP](https://docs.tempo.xyz/)

## 3. 当前系统边界

```text
Agent（买方）
   │ 预付、锁款或签署授权
   ▼
HTTP/API 层 ── 检查请求与签名 ──► 返回数字服务
   │
   ▼
AgentPayVault / ChannelVault
   │ 记录时间、额度、累计 voucher、交付状态
   ▼
Provider（服务商）提现或结算
```

### 3.1 角色

- **Agent**：购买 API、算力、数据或任务结果。
- **Provider**：提供服务并获得结算收入。
- **Vault**：保存预付资金与状态，不判断服务内容本身。
- **HTTP 中间件 / Relayer**：验证授权、返回服务，并在需要时代 Provider 提交结算。

当前 UI 为了单钱包演示，把 Agent 与 Provider 折叠成同一个连接地址。因此页面证明的是状态机可以运行，不是完整的双边商业交易。路演必须主动说明这一点。

## 4. 当前实现

### 4.1 Stream：时间驱动

```text
openStream(payee, ratePerSecond)
  → earned(id) 按时间读取应计金额
  → withdrawStream(id) 服务商提取已归属金额
  → closeStream(id) 结清服务商并退回剩余余额
```

当前性质：

- Agent 预付原生 MON；
- `earned` 使用 `min(elapsed × rate, deposit)`，不会超出押金；
- 不需要 keeper 或 cron 推动余额；
- `solvent` 可供服务端通过一次 `eth_call` 判断服务是否继续；
- 页面按秒刷新只是展示，真正金额来自合约时间公式。

适合讲解：持续推理会话只为实际使用的秒数付费。

### 4.2 Meter：逐次授权与记账

```text
Provider createPlan(price)
  → Agent subscribe(planId, calls)
  → Agent 签 MeterAuth(planId, agent, callIndex)
  → Provider/Relayer 调 meter(...signature)
  → credits - 1，callSeq + 1，收入进入 pending
  → Provider withdrawProvider()
```

安全约束：

- EIP-712 domain 绑定 chain ID 和合约地址；
- `callIndex` 必须等于链上 `callSeq`，防止重放和跳号；
- 服务商收入采用 `pending` 后主动提现；
- `protocolFeeBps` 只在 `meter()` 路径收取，默认 0、上限 5%；
- `call()` 是 Agent 自付 gas 的直调备选路径，但当前不会扣协议费。

当前真实性边界：

- `/api/paid-data` 会返回真实 HTTP 402，并验证额度、序号和 EIP-712 签名；
- 它使用自定义 `x-payment-auth` 头和 `meter-eip712` scheme，不是 x402 v2 标准头部与标准 scheme；
- 首页按钮没有请求该 API，而是本地签名后直接调用 `meter()`；
- 当前连接钱包实际提交 `meter()`，所以 UI 不能证明“Agent 零 gas、Provider 代付”；
- 准确口径是“x402 风格参考实现 + 可由服务商/relayer 代提交的链上 Meter 原语”。

### 4.3 Channel：批量调用结算

```text
Agent openChannel(provider, expiry)
  → 每次调用离线签 Voucher(channelId, cumulativeAmount)
  → Provider 提交最后一张 voucher
  → claim 只支付 cumulativeAmount - settled
  → 过期后 Agent closeChannel 取回余额
```

累计金额严格递增，旧 voucher 会因 `stale voucher` 被拒绝。大量调用可以压缩为“开通道 + 最终结算”两笔链上交易，也允许中途多次 claim。

当前 ChannelVault 是自定义 EIP-712 通道，与 MPP Session 的思路相近，但没有实现或验证 MPP 协议兼容性。路演只能说“语义对齐/同类设计”，不能说“MPP 兼容实现”。

### 4.4 Optimistic Escrow：任务交付

```text
Locked
  ├─ 到期未交付 → Refunded（100% 退 Agent）
  └─ Provider deliver → Delivered / 开启争议窗口
                         ├─ Agent release → Provider 100%
                         ├─ Agent dispute → Agent 50% / Provider 50%
                         └─ 窗口结束 claim → Provider 100%
```

当前版本已经完成乐观托管升级：买方装死不再锁死服务商资金，服务商不交付也能超时退款。

边界：

- `expectedHash` 已存链上，但是否匹配由 Agent 链下判断；
- `deliveryHash` 绑定 escrow ID、payee 和 resultHash，防跨任务直接复用；
- 合约不会自动判断“交付物好不好”；
- `arbiter` 只是预留字段；当前争议固定 50/50，不是仲裁；
- 50/50 是可预测的最小退出规则，不等于完整公平裁决。

### 4.5 P256：能力验证，不在结算主路径

页面生成 P256 密钥、签名并调用 Monad `0x0100` precompile。它证明设备密钥/Passkey 类签名可以在 Monad 原生验证，但当前没有连接 `release()`、`meter()` 或账户权限。

准确口径：

> 已验证的 Agent 硬件密钥入口，下一步接入账户授权与 Escrow 确认。

### 4.6 ParallelLens：机制解释 + 真实负载

- `/lens` 上半部分是本地确定性模拟器，展示同一快照并行执行、读集失效和覆盖重执行；
- `ConflictLab` 故意让多笔交易写 `hotCounter`，制造链上热状态；
- `LivePanel` 展示真实测试网交易和同块打包结果；
- 同块多笔交易不能单独证明节点内部发生并行或重执行，因此不要称为“链上实锤”；
- 正确说法是：模拟器解释 Monad 官方执行模型，ConflictLab 生成真实冲突型负载并验证最终状态不丢交易。

Monad 官方描述：交易先乐观并行生成 pending result，串行提交时检查输入，输入失效则重执行，从而保持与串行执行相同的结果。参考 [How Monad Works](https://www.monad.xyz/announcements/how-monad-works)。

## 5. 真实性分层

| 能力                          | 当前状态                       | 台上口径                   |
| ----------------------------- | ------------------------------ | -------------------------- |
| Stream 按秒累计与结清         | 已实现、已部署                 | 可以直接演示               |
| Meter EIP-712 防重放          | 已实现、已部署                 | 可以直接演示               |
| Channel 累计 voucher          | 已实现、已部署                 | 可以直接演示               |
| 乐观托管 claim/dispute/refund | 已实现、已有测试脚本           | 可以直接演示               |
| 真 HTTP 402                   | 已实现参考路由                 | 说明为自定义 x402 风格流程 |
| x402 v2 协议兼容              | 未实现                         | Roadmap，不可声称兼容      |
| MPP 协议兼容                  | 未实现                         | 只能说设计语义相近         |
| Provider 代付 gas             | 合约支持，首页未形成双钱包闭环 | 说明目标调用方式           |
| P256 验签                     | 已验证、独立面板               | 不声称已接入结算主路径     |
| ParallelLens 执行模型         | 本地模拟 + 链上负载            | 不把同块打包说成重执行证明 |
| 主网级安全                    | 未完成                         | 测试网原型，明确加固清单   |

## 6. 产品战略

### 6.1 最强切入口

首批客户不是泛化“所有 Agent”，而是已经提供机器可调用服务的 Provider：

- 模型推理与 Agent 托管；
- RPC、索引和数据 API；
- 搜索、研究与自动化工具；
- MCP 工具服务商。

他们已经有可计量的数字服务，但缺少跨请求的链上预算、结算和退款状态。

### 6.2 差异化

不要把差异化讲成“功能最多”，而要讲成“一个统一决策模型”：

```text
服务按时间存在？        → Stream
服务按离散次数消费？    → 少量用 Meter，大量用 Channel
服务需要验收后付款？    → Optimistic Escrow
```

真正优势：

1. 同一套角色与资金模型覆盖三种消费关系；
2. 每种关系都有明确退出路径，不只是支付按钮；
3. 使用 Monad 的低延迟、并行执行和 P256 能力构建机器支付体验；
4. 合约、测试网部署、UI 和演示脚本都存在，不是纯概念稿。

### 6.3 商业模式

当前 `protocolFeeBps` 只覆盖 Meter 路径，不能宣称全协议已经完成统一抽成。合理演进：

- Meter 结算抽成；
- Stream / Channel / Escrow 增加统一 fee policy；
- Provider SDK、托管 relayer 和对账服务；
- 企业级限额、白名单、审计与 SLA。

## 7. 为什么是 Monad

| Monad 能力                       | 对 AgentPay 的意义                       | 当前证据                                           |
| -------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| EVM 兼容与高吞吐                 | 同一服务商面对大量 Agent 调用            | 已部署 Solidity 合约与 ConflictLab 负载            |
| 乐观并行执行                     | 独立状态可并行，热状态冲突重执行保持正确 | `/lens` 模拟器对应官方模型                         |
| 约 400ms 区块、约 800ms finality | 交互反馈快，适合机器请求循环             | 使用官方当前网络参数，不再说 0.3s/0.6s             |
| P256VERIFY                       | Agent 可使用设备密钥或 Passkey 类签名    | `0x0100` 面板实测                                  |
| 较高 gas capacity                | 支持更密集的 Meter 与结算交易            | `meter()` 有本地测量脚本，金额换算需实时 gas price |

官方当前文档给出的公开参数为 10,000 TPS、400ms block frequency、800ms finality；网络参数可能升级，正式路演前应再次核对 [Monad Documentation](https://docs.monad.xyz/)。

## 8. 竞品与协议位置

| 类别          | 代表                       | 解决什么                             | AgentPay 的关系                                      |
| ------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------- |
| HTTP 机器支付 | x402                       | 请求、支付要求、签名、验证与单次结算 | 应成为上游协议；当前仅有自定义风格参考路由           |
| 机器支付会话  | MPP / Tempo                | Session、streaming 等机器支付能力    | Channel/Stream 概念相邻，但当前未协议兼容            |
| 流支付协议    | Superfluid 等              | 持续资金流                           | AgentPay 当前是简化的预付时间金库，不依赖外部 keeper |
| 托管/仲裁市场 | 人工仲裁、抵押或声誉系统   | 更强纠纷处理                         | AgentPay 选择零仲裁、低协调成本，但保护力度更弱      |
| 支付基础设施  | 钱包、facilitator、relayer | 签名、代付、广播与对账               | AgentPay 应集成，不应取代                            |

竞争口径：

> 我们不是另一个支付 header，也不是另一个 Agent 市场。我们提供的是支付协议和 Agent 服务之间缺少的“长期资金关系状态机”。

## 9. 风险与优先级

### P0：路演可信度

1. UI 明示 Demo 模式中 Agent 与 Provider 使用同一地址；
2. 不再把首页按钮描述为完整 x402 或真实 Provider 代付；
3. 不再声称 MPP 兼容；
4. 不再把同块打包直接称为并行执行证明；
5. 演示前准备已进入 Delivered 状态的 Escrow，避免现场等待。

### P1：产品闭环

1. 两钱包角色视图，分别展示 Agent 与 Provider 余额；
2. 首页真实请求 `/api/paid-data`；
3. Provider relayer 收到授权后提交 `meter()`；
4. 改为 x402 v2 标准头部和可注册 scheme；
5. P256 或账户权限真正接入结算授权。

### P2：主网安全

1. 使用 USDC + SafeERC20；
2. 加 ReentrancyGuard、暂停机制和权限治理；
3. Stream、Channel、Escrow 统一 fee policy；
4. 将现有 Escrow 单元测试扩展到全合约，并补状态机 invariant、fuzz 和外部审计；
5. 激活 arbiter hook 或设计可插拔争议策略。

## 10. 答辩原则

### 必须说

- “这是测试网原型，核心状态机已经部署。”
- “三种消费关系，离散调用有实时与批量两种结算方式。”
- “HTTP 402 路由是自定义 x402 风格参考实现，标准兼容是下一步。”
- “P256 与 ParallelLens 是 Monad 能力验证，不是额外支付产品。”

### 不要说

- “x402 只授权、不结算。”
- “我们已经完整兼容 x402 / MPP。”
- “一万次调用永远只需要两笔交易。”——只有最终单次 claim 时成立。
- “P256 已用于 Escrow。”
- “同一个区块就是并行执行实锤。”
- “50/50 等于公平仲裁。”
- “主网已经安全可用。”

### 收束句

> **支付解决一次动作，AgentPay 管理一段经济关系。**
