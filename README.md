# ⚡ AgentPay Vault —— AI Agent 微支付结算层

> Monad Blitz 北京 V2 · 2026-08-15
> **x402 处理单次 HTTP 支付流程；AgentPay Vault 在 Monad 上管理跨时间、跨调用与跨任务的结算状态。**

- **线上 Demo**: https://nextjs-peach-nine-16.vercel.app （`/lens` 为并行执行可视化彩蛋页）
- **国内直连镜像**: http://112.124.3.17/agentpay （vercel.app 在大陆网络不可达时的备用入口）
- **链**: Monad Testnet (Chain ID 10143)

| 合约                                            | 地址                                         |
| ----------------------------------------------- | -------------------------------------------- |
| AgentPayVault（流支付 + 按次 meter + 乐观托管） | `0x1236c35d325314890f6ab14a549bf057ac01931a` |
| ChannelVault（EIP-712 voucher 通道）            | `0x36b45aea8267b0efb232a3a2515240a5c5178523` |
| ConflictLab（并行冲突实验台）                   | `0xe4ef366c5c5ad646c8c044a3ab579b32c1cc447e` |

## 为什么存在

x402 覆盖单次 HTTP 请求中的支付要求、授权、验证与结算；但 agent 经济还有三种跨请求关系——**连续服务、离散调用、任务交付**。AgentPay Vault 提供这些关系所需的链上结算状态机。

## 三个合约原语 + 一个实证

### 1. 流支付金库 Stream（时间驱动）

```
openStream(payee, ratePerSecond) payable  →  earned(id) 读时结算  →  withdrawStream / closeStream
```

无循环、无 keeper、数学自动收敛（对比 Superfluid 依赖 keeper 清算）。`solvent(id)` 一次 eth_call 放行——这是给服务端中间件的接口。

### 2. 按次计量 meter（用量驱动）

```
createPlan(pricePerCall)  →  subscribe(planId, calls) payable  →  meter(planId, agent, callIndex, v, r, s)
```

agent 每次调用可离线签 `MeterAuth`（EIP-712，绑定 chainId、合约地址，callIndex 严格递增防重放），由服务商或 relayer 持签名上链记账，因此 agent 无需为该笔 `meter` 交易付 gas。`call(planId)` 保留 agent 自助模式。费用记账到 `pending[provider]`（pull over push），`protocolFeeBps` 为结算抽成开关。

### 3. 乐观托管 Escrow（任务交付）

```
lockEscrow → deliver(开争议窗口) → release(买方确认 100%)
                                 → claim(窗口无争议，服务商乐观取款 100%)
                                 → dispute(窗口内，50/50 强制 split)
              未交付 → refundExpired(任何人可触发，pull 模式)
```

**博弈覆盖**：买方装死→claim 堵死；交垃圾→dispute 可信威胁；服务商跑路→refund；恶意 dispute→最多拿回 50%。零仲裁者、零抵押——高频小额 agent 交易押不起保证金、等不起仲裁。

**叙事同构**：Monad 执行层乐观并行（先跑、冲突重放）⇆ 我们结算层乐观托管（先放款、争议惩罚）——乐观假设 + 事后纠错，换取无协调者的吞吐。

### 4. ChannelVault（累计 voucher 通道）

`Voucher(channelId, cumulativeAmount)` 累计单调递增即 nonce（省一个参数，旧 voucher 直接拒绝）。一万次调用 = 2 笔链上交易。通道模式与 meter 模式并存：**Monad 的低 gas 让通道从必需品变成优化项**。

它与 MPP Session 都采用“多次链下授权、最终链上结算”的思路，但当前实现不是 MPP 协议兼容实现。

## Monad 原生性对账单（全部实测，非 PPT）

| Monad 特性                          | 证据                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 低 gas · 按次实时记账成立           | `meter()` 实测 **118,438 gas**（≈ 普通转账 5.6×），tx `0x4604d1fc…`，可链上复核                         |
| 0.3s 块 / 0.6s 终局（MIP-12）       | 流支付余额条按秒真实变动，demo 即证据                                                                   |
| P256 precompile（0x0100, RIP-7212） | 双网 eth_call 实测返回 1；前端面板可现场验签（模拟 agent 的 Secure Enclave 密钥）                       |
| 乐观并行执行                        | ConflictLab 生成真实热状态竞争；`/lens` 按 Monad 的执行模型解释冲突与重执行，不把前端模拟当作链底层遥测 |

## 中间件参考实现

`GET /api/paid-data`：无授权 → **HTTP 402** + 支付要求 JSON；携带 agent 的 MeterAuth 签名 → 验签 + 查额度 → 200 数据。当前使用自定义 `x-payment-auth` 请求头与 `meter-eip712` scheme，是 x402 风格的集成原型，不是 x402 v2 兼容实现。

## 设计取舍（诚实清单）

- 支付媒介用原生 MON 演示；主网版切 USDC（SafeERC20，Circle faucet 测试网 USDC 已就绪）
- 转账用低级 call、无 ReentrancyGuard（CEI 顺序正确）；主网版加固
- ChannelVault `claim` 为 push 直转（单笔即结、金额小）；沉淀收入走 pending pull
- P256 演示用 noble-curves 模拟 passkey；真 WebAuthn 进 roadmap
- dispute 当前为 50/50 谢林点；`arbiter` 字段预留，争议裁决网络为 roadmap

## 开发

```bash
yarn install
yarn chain          # 本地链
yarn deploy         # 本地部署
yarn start          # 前端 localhost:3000
# 测试网
yarn deploy --network monadTestnet
yarn hardhat:test                                  # 正式合约测试（CI 同步执行）
node packages/nextjs/scripts/measure-meter-gas.mjs # gas 实测脚本
```

## Roadmap

乐观托管全量版（可选买方押金防勒索）→ 渐变托管（时间×任务复合释放）→ Envio/Goldsky 索引仪表盘 → 真 WebAuthn passkey → USDC 主网版 → dispute 事件沉淀为 agent 声誉数据。
