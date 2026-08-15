//SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

/**
 * AgentPayVault —— AI Agent 微支付结算层
 *
 * 三种结算模式合在一个合约里：
 * 1. 流支付金库 Stream   : 按秒流式付费（预付押金，随用随取，关闭退余额）
 * 2. 按次付费订阅 Plan    : 预付 N 次调用额度，每次 call 扣 1，服务商记账提现
 * 3. Escrow 结算          : 锁款 → 交付凭证哈希 → 确认释放 / 超时退款
 *
 * 并行执行叙事：pending[provider] 是所有并发 call 争抢的热状态，
 * Monad 乐观并行执行 + 冲突重执行保证高并发下依然正确。
 */
contract AgentPayVault {
    // ---------- 1. 流支付 ----------
    struct Stream {
        address payer;
        address payee;
        uint256 deposit; // 剩余押金
        uint256 ratePerSecond; // 每秒费率 (wei/s)
        uint256 start;
        uint256 withdrawn; // 已提取总额
        bool active;
    }
    uint256 public streamCount;
    mapping(uint256 => Stream) public streams;

    event StreamOpened(uint256 indexed id, address indexed payer, address indexed payee, uint256 deposit, uint256 rate);
    event StreamWithdrawn(uint256 indexed id, uint256 amount, uint256 elapsed);
    event StreamClosed(uint256 indexed id, uint256 refunded, uint256 paid);

    // ---------- 2. 按次付费 ----------
    struct Plan {
        address provider;
        uint256 pricePerCall;
        bool active;
    }
    uint256 public planCount;
    mapping(uint256 => Plan) public plans;
    mapping(uint256 => mapping(address => uint256)) public credits; // planId => agent => 剩余次数
    mapping(uint256 => mapping(address => uint256)) public callSeq; // planId => agent => 已授权调用序号
    mapping(address => uint256) public pending; // 服务商待提现余额（热状态！）

    // EIP-712：agent 每次调用签 MeterAuth 授权，服务商持签名上链 meter()
    bytes32 public constant METER_TYPEHASH = keccak256("MeterAuth(uint256 planId,address agent,uint256 callIndex)");
    bytes32 public immutable PLAN_DOMAIN_SEPARATOR;

    // 商业模式开关：结算层抽成（默认 0，被问商业模式时的现成答案）
    address public protocol;
    uint256 public protocolFeeBps; // 万分比，默认 0

    event PlanCreated(uint256 indexed planId, address indexed provider, uint256 pricePerCall);
    event Subscribed(uint256 indexed planId, address indexed agent, uint256 calls);
    event ServiceCalled(uint256 indexed planId, address indexed agent, uint256 nonce);
    event Metered(uint256 indexed planId, address indexed agent, uint256 callIndex, uint256 fee);
    event ProviderWithdrawn(address indexed provider, uint256 amount);

    // ---------- 3. Escrow（乐观托管：先放款、争议惩罚） ----------
    enum EscrowStatus {
        Locked,
        Delivered,
        Released,
        Refunded,
        Disputed
    }
    struct Escrow {
        address payer;
        address payee;
        uint256 amount;
        bytes32 expectedHash; // 期望交付物哈希（agent 链下比对后 release）
        bytes32 deliveryHash; // 绑定上下文的交付凭证 keccak256(id, payee, resultHash)
        uint256 deadline; // 交付截止（超时未交付可退款）
        uint256 challengeDeadline; // 争议窗口（交付后开启）
        uint256 challengePeriod; // 争议窗口时长
        EscrowStatus status;
        address arbiter; // 仲裁 hook（争议裁决为 roadmap 项；当前 dispute = 50/50 谢林点）
    }
    uint256 public escrowCount;
    mapping(uint256 => Escrow) public escrows;

    event EscrowLocked(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount);
    event EscrowDelivered(uint256 indexed id, bytes32 boundHash, uint256 challengeDeadline);
    event EscrowReleased(uint256 indexed id);
    event EscrowClaimed(uint256 indexed id); // 窗口期无争议，服务商乐观取款
    event EscrowDisputed(uint256 indexed id, uint256 toPayer, uint256 toPayee); // 50/50 强制 split
    event EscrowRefunded(uint256 indexed id);

    constructor() {
        protocol = msg.sender;
        PLAN_DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AgentPayVault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// 协议方设置抽成（万分比，上限 5%）
    function setProtocolFee(uint256 bps) external {
        require(msg.sender == protocol, "AgentPay: not protocol");
        require(bps <= 500, "AgentPay: fee too high");
        protocolFeeBps = bps;
    }

    /// meter 授权摘要（前端 signTypedData 用同一个）
    function meterDigest(uint256 planId, address agent, uint256 callIndex) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    PLAN_DOMAIN_SEPARATOR,
                    keccak256(abi.encode(METER_TYPEHASH, planId, agent, callIndex))
                )
            );
    }

    // ================= 流支付 =================

    function openStream(address payee, uint256 ratePerSecond) external payable returns (uint256 id) {
        require(msg.value > 0, "AgentPay: deposit required");
        require(ratePerSecond > 0, "AgentPay: rate required");
        id = ++streamCount;
        streams[id] = Stream({
            payer: msg.sender,
            payee: payee,
            deposit: msg.value,
            ratePerSecond: ratePerSecond,
            start: block.timestamp,
            withdrawn: 0,
            active: true
        });
        emit StreamOpened(id, msg.sender, payee, msg.value, ratePerSecond);
    }

    /// 当前已累积、服务商还可提取的金额（deposit 为总充值，恒定）
    function earned(uint256 id) public view returns (uint256) {
        Stream storage s = streams[id];
        uint256 accrued = (block.timestamp - s.start) * s.ratePerSecond;
        uint256 totalOwed = accrued > s.deposit ? s.deposit : accrued;
        return totalOwed > s.withdrawn ? totalOwed - s.withdrawn : 0;
    }

    /// 中间件放行检查：一次 eth_call，流未关闭且押金未耗尽即可服务
    function solvent(uint256 id) external view returns (bool) {
        Stream storage s = streams[id];
        return s.active && (block.timestamp - s.start) * s.ratePerSecond < s.deposit;
    }

    /// 服务商提取已流到的钱
    function withdrawStream(uint256 id) external {
        Stream storage s = streams[id];
        require(msg.sender == s.payee, "AgentPay: not payee");
        require(s.active, "AgentPay: closed");
        uint256 amount = earned(id);
        require(amount > 0, "AgentPay: nothing earned");
        s.withdrawn += amount;
        emit StreamWithdrawn(id, amount, block.timestamp - s.start);
        (bool ok, ) = s.payee.call{ value: amount }("");
        require(ok, "AgentPay: transfer failed");
    }

    /// 付款方关闭流：已累积部分结算给服务商，剩余退回
    function closeStream(uint256 id) external {
        Stream storage s = streams[id];
        require(msg.sender == s.payer, "AgentPay: not payer");
        require(s.active, "AgentPay: closed");
        s.active = false;
        uint256 outstanding = earned(id); // 已累积未提取
        uint256 refund = s.deposit - s.withdrawn - outstanding;
        s.withdrawn = s.deposit; // 标记全部结清
        emit StreamClosed(id, refund, outstanding);
        if (outstanding > 0) {
            (bool ok1, ) = s.payee.call{ value: outstanding }("");
            require(ok1, "AgentPay: payee transfer failed");
        }
        if (refund > 0) {
            (bool ok2, ) = s.payer.call{ value: refund }("");
            require(ok2, "AgentPay: refund failed");
        }
    }

    // ================= 按次付费 =================

    function createPlan(uint256 pricePerCall) external returns (uint256 planId) {
        planId = ++planCount;
        plans[planId] = Plan({ provider: msg.sender, pricePerCall: pricePerCall, active: true });
        emit PlanCreated(planId, msg.sender, pricePerCall);
    }

    /// agent 预付 N 次调用额度
    function subscribe(uint256 planId, uint256 calls) external payable {
        Plan storage p = plans[planId];
        require(p.active, "AgentPay: plan inactive");
        require(calls > 0 && msg.value == p.pricePerCall * calls, "AgentPay: wrong amount");
        credits[planId][msg.sender] += calls;
        emit Subscribed(planId, msg.sender, calls);
    }

    /// agent 自助调用（agent 自己付 gas 实时结算）
    function call(uint256 planId) external {
        Plan storage p = plans[planId];
        require(p.active, "AgentPay: plan inactive");
        require(credits[planId][msg.sender] > 0, "AgentPay: no credits");
        credits[planId][msg.sender]--;
        callSeq[planId][msg.sender]++;
        pending[p.provider] += p.pricePerCall;
        emit ServiceCalled(planId, msg.sender, credits[planId][msg.sender]);
    }

    /// x402 授权调用：agent 离线签 MeterAuth，服务商持签名上链记账
    /// 支付授权随请求携带 —— agent 零 gas，服务商代付 gas 结算
    function meter(uint256 planId, address agent, uint256 callIndex, uint8 v, bytes32 r, bytes32 s) external {
        Plan storage p = plans[planId];
        require(p.active, "AgentPay: plan inactive");
        require(callIndex == callSeq[planId][agent], "AgentPay: bad call index");
        require(ecrecover(meterDigest(planId, agent, callIndex), v, r, s) == agent, "AgentPay: bad auth sig");
        require(credits[planId][agent] > 0, "AgentPay: no credits");
        credits[planId][agent]--;
        callSeq[planId][agent]++;
        uint256 fee = (p.pricePerCall * protocolFeeBps) / 10000;
        pending[p.provider] += p.pricePerCall - fee;
        if (fee > 0) pending[protocol] += fee;
        emit Metered(planId, agent, callIndex, fee);
    }

    /// 服务商提现累计收入
    function withdrawProvider() external {
        uint256 amount = pending[msg.sender];
        require(amount > 0, "AgentPay: nothing to withdraw");
        pending[msg.sender] = 0;
        emit ProviderWithdrawn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{ value: amount }("");
        require(ok, "AgentPay: transfer failed");
    }

    // ================= Escrow（乐观托管：先放款、争议惩罚） =================
    // 博弈覆盖：买方装死→claim 堵死；交垃圾→dispute 可信威胁；跑路→refund；恶意 dispute→最多拿回 50%

    /// agent 锁定资金：期望交付哈希 + 交付截止 + 争议窗口时长；arbiter 传 0 地址表示无仲裁
    function lockEscrow(
        address payee,
        bytes32 expectedHash,
        uint256 timeoutSecs,
        uint256 challengeSecs,
        address arbiter
    ) external payable returns (uint256 id) {
        require(msg.value > 0, "AgentPay: amount required");
        id = ++escrowCount;
        escrows[id] = Escrow({
            payer: msg.sender,
            payee: payee,
            amount: msg.value,
            expectedHash: expectedHash,
            deliveryHash: bytes32(0),
            deadline: block.timestamp + timeoutSecs,
            challengeDeadline: 0,
            challengePeriod: challengeSecs,
            status: EscrowStatus.Locked,
            arbiter: arbiter
        });
        emit EscrowLocked(id, msg.sender, payee, msg.value);
    }

    /// 服务商提交交付凭证：存绑定上下文的哈希防跨任务重用；同时开启争议窗口
    function deliver(uint256 id, bytes32 resultHash) external {
        Escrow storage e = escrows[id];
        require(msg.sender == e.payee, "AgentPay: not payee");
        require(e.status == EscrowStatus.Locked, "AgentPay: not locked");
        require(block.timestamp <= e.deadline, "AgentPay: past deadline");
        bytes32 boundHash = keccak256(abi.encode(id, msg.sender, resultHash));
        e.deliveryHash = boundHash;
        e.challengeDeadline = block.timestamp + e.challengePeriod;
        e.status = EscrowStatus.Delivered;
        emit EscrowDelivered(id, boundHash, e.challengeDeadline);
    }

    /// agent 确认交付（链下比对 resultHash 与 expectedHash 后调用）→ 100% 给服务商
    function release(uint256 id) external {
        Escrow storage e = escrows[id];
        require(msg.sender == e.payer, "AgentPay: not payer");
        require(e.status == EscrowStatus.Delivered, "AgentPay: not delivered");
        e.status = EscrowStatus.Released;
        emit EscrowReleased(id);
        (bool ok, ) = e.payee.call{ value: e.amount }("");
        require(ok, "AgentPay: transfer failed");
    }

    /// 争议窗口内买方发起 dispute → 50/50 强制 split（双输谢林点，恶意争议最多拿回一半）
    function dispute(uint256 id) external {
        Escrow storage e = escrows[id];
        require(msg.sender == e.payer, "AgentPay: not payer");
        require(e.status == EscrowStatus.Delivered, "AgentPay: not delivered");
        require(block.timestamp <= e.challengeDeadline, "AgentPay: window closed");
        e.status = EscrowStatus.Disputed;
        uint256 half = e.amount / 2;
        emit EscrowDisputed(id, half, e.amount - half);
        (bool ok1, ) = e.payer.call{ value: half }("");
        require(ok1, "AgentPay: payer split failed");
        (bool ok2, ) = e.payee.call{ value: e.amount - half }("");
        require(ok2, "AgentPay: payee split failed");
    }

    /// 争议窗口结束无人 dispute → 服务商乐观取款 100%（买方装死不再卡死资金）
    function claim(uint256 id) external {
        Escrow storage e = escrows[id];
        require(msg.sender == e.payee, "AgentPay: not payee");
        require(e.status == EscrowStatus.Delivered, "AgentPay: not delivered");
        require(block.timestamp > e.challengeDeadline, "AgentPay: window open");
        e.status = EscrowStatus.Released;
        emit EscrowClaimed(id);
        (bool ok, ) = e.payee.call{ value: e.amount }("");
        require(ok, "AgentPay: transfer failed");
    }

    /// 超时未交付 → 任何人可触发退款（pull 模式，资金退回 payer）
    function refundExpired(uint256 id) external {
        Escrow storage e = escrows[id];
        require(e.status == EscrowStatus.Locked, "AgentPay: already delivered");
        require(block.timestamp > e.deadline, "AgentPay: not expired");
        e.status = EscrowStatus.Refunded;
        emit EscrowRefunded(id);
        (bool ok, ) = e.payer.call{ value: e.amount }("");
        require(ok, "AgentPay: refund failed");
    }
}
