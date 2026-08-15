//SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

/**
 * ChannelVault —— 按次计量支付通道（离散 API 调用场景）
 *
 * agent 开通道锁预算，之后每次调用只离线签一张 EIP-712 voucher
 * （金额累计单调递增），服务商随时拿【最后一张】voucher 上链批量结算。
 * 一万次调用 = 2 笔链上交易（开 + 结）。
 *
 * 设计说明：cumulativeAmount 单调递增天然防重放，无需额外 nonce。
 */
contract ChannelVault {
    struct Channel {
        address agent;
        address provider;
        uint256 budget; // 锁定总预算
        uint256 expiry; // 过期后 agent 可取回余额
        uint256 settled; // 已结算累计额
        bool closed;
    }

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 public channelNonce;
    mapping(bytes32 => Channel) public channels;

    event ChannelOpened(bytes32 indexed channelId, address indexed agent, address indexed provider, uint256 budget);
    event ChannelClaimed(bytes32 indexed channelId, uint256 cumulativeAmount, uint256 delta);
    event ChannelClosed(bytes32 indexed channelId, uint256 refunded);

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AgentPayChannelVault")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// agent 开通道，锁定预算
    function openChannel(address provider, uint256 expirySecs) external payable returns (bytes32 channelId) {
        require(msg.value > 0, "ChannelVault: budget required");
        channelId = keccak256(abi.encode(msg.sender, provider, ++channelNonce));
        channels[channelId] = Channel({
            agent: msg.sender,
            provider: provider,
            budget: msg.value,
            expiry: block.timestamp + expirySecs,
            settled: 0,
            closed: false
        });
        emit ChannelOpened(channelId, msg.sender, provider, msg.value);
    }

    /// 对 voucher 的 EIP-712 摘要
    function voucherDigest(bytes32 channelId, uint256 cumulativeAmount) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR,
                    keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount))
                )
            );
    }

    /// 服务商提交最后一张 voucher 结算（可多次，每次按增量结算）
    function claim(bytes32 channelId, uint256 cumulativeAmount, uint8 v, bytes32 r, bytes32 s) external {
        Channel storage c = channels[channelId];
        require(!c.closed, "ChannelVault: closed");
        require(cumulativeAmount > c.settled, "ChannelVault: stale voucher");
        require(cumulativeAmount <= c.budget, "ChannelVault: exceeds budget");

        address signer = ecrecover(voucherDigest(channelId, cumulativeAmount), v, r, s);
        require(signer == c.agent, "ChannelVault: bad voucher signature");

        uint256 delta = cumulativeAmount - c.settled;
        c.settled = cumulativeAmount;
        emit ChannelClaimed(channelId, cumulativeAmount, delta);
        (bool ok, ) = c.provider.call{ value: delta }("");
        require(ok, "ChannelVault: transfer failed");
    }

    /// 过期后 agent 关闭通道取回未消费余额
    function closeChannel(bytes32 channelId) external {
        Channel storage c = channels[channelId];
        require(msg.sender == c.agent, "ChannelVault: not agent");
        require(!c.closed, "ChannelVault: closed");
        require(block.timestamp > c.expiry, "ChannelVault: not expired");
        c.closed = true;
        uint256 refund = c.budget - c.settled;
        emit ChannelClosed(channelId, refund);
        if (refund > 0) {
            (bool ok, ) = c.agent.call{ value: refund }("");
            require(ok, "ChannelVault: refund failed");
        }
    }
}
