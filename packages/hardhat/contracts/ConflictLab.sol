//SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

/**
 * ConflictLab — ParallelLens 的链上实验台
 * 故意制造"热状态"：所有交易都读写共享账本 + 全局计数器，
 * 用于演示/测量 Monad 乐观并行执行下的状态冲突与重执行。
 */
contract ConflictLab {
    mapping(address => uint256) public balanceOf;
    // 每笔交易都会写的全局热计数器 —— 并行执行时的冲突制造机
    uint256 public hotCounter;
    // 记录总共发生过多少笔转账
    uint256 public totalTransfers;

    event TransferExecuted(address indexed from, address indexed to, uint256 amount, uint256 hotSlot);
    event Deposited(address indexed who, uint256 amount, uint256 hotSlot);
    event Bumped(address indexed who, uint256 hotSlot);

    constructor() {
        // 给部署者预存 1000，复刻 Monad101 讲座里 Alice 起始 $1000 的案例
        balanceOf[msg.sender] = 1000;
    }

    /// 充值（付真 MON 或记账都行）
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        hotCounter++;
        emit Deposited(msg.sender, msg.value, hotCounter);
    }

    /// 转账 —— 读写 balanceOf[双方] + hotCounter，典型的状态冲突交易
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "ConflictLab: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        hotCounter++;
        totalTransfers++;
        emit TransferExecuted(msg.sender, to, amount, hotCounter);
    }

    /// 只碰热计数器 —— 制造"纯热状态冲突"的最小交易
    function bump() external {
        hotCounter++;
        emit Bumped(msg.sender, hotCounter);
    }
}
