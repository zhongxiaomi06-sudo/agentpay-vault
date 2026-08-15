import { network } from "hardhat";

// 乐观托管全状态机实测（ethers 版）
const { ethers } = await network.connect();
const [deployer] = await ethers.getSigners();
const addr = deployer.address;

const vault = await ethers.deployContract("AgentPayVault");
const H = "0x" + "11".repeat(32);
const R = "0x" + "22".repeat(32);
const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_MON = ethers.parseEther("1");

// --- 路径 A：deliver → claim ---
await (await vault.lockEscrow(addr, H, 600, 60, ZERO, { value: ONE_MON })).wait();
await (await vault.deliver(1n, R)).wait();

let earlyClaimReverted = false;
try {
  await (await vault.claim(1n)).wait();
} catch {
  earlyClaimReverted = true;
}
console.log("✓ 窗口未结束 claim 抢跑被拒绝:", earlyClaimReverted);

await ethers.provider.send("evm_increaseTime", [61]);
await ethers.provider.send("evm_mine", []);
await (await vault.claim(1n)).wait();
console.log("✓ 争议窗口后乐观取款成功, status =", (await vault.escrows(1n)).status.toString(), "(2=Released)");

// --- 路径 B：deliver → dispute 50/50 ---
await (await vault.lockEscrow(addr, H, 600, 60, ZERO, { value: ONE_MON })).wait();
await (await vault.deliver(2n, R)).wait();
await (await vault.dispute(2n)).wait();
console.log("✓ dispute 50/50 完成, status =", (await vault.escrows(2n)).status.toString(), "(4=Disputed)");

// --- 路径 C：不交付 → refundExpired ---
await (await vault.lockEscrow(addr, H, 60, 60, ZERO, { value: ONE_MON })).wait();
await ethers.provider.send("evm_increaseTime", [61]);
await ethers.provider.send("evm_mine", []);
await (await vault.refundExpired(3n)).wait();
console.log("✓ 超时退款完成, status =", (await vault.escrows(3n)).status.toString(), "(3=Refunded)");

// --- expectedHash 已闭环存储（P0 修复验证） ---
console.log("✓ expectedHash 已存储:", (await vault.escrows(1n)).expectedHash === H);
