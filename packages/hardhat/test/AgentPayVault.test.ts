import { expect } from "chai";
import { network } from "hardhat";

const EXPECTED_HASH = `0x${"11".repeat(32)}`;
const RESULT_HASH = `0x${"22".repeat(32)}`;
const ONE_MON = 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function deployVault() {
  const { ethers } = await network.create();
  const [payer, payee, caller] = await ethers.getSigners();
  const vault = await ethers.deployContract("AgentPayVault");
  const vaultAddress = await vault.getAddress();
  const payerVault = await ethers.getContractAt("AgentPayVault", vaultAddress, payer);
  const payeeVault = await ethers.getContractAt("AgentPayVault", vaultAddress, payee);
  const callerVault = await ethers.getContractAt("AgentPayVault", vaultAddress, caller);

  return { ethers, payer, payee, caller, vault, payerVault, payeeVault, callerVault };
}

async function lockAndDeliver(challengePeriod = 60) {
  const fixture = await deployVault();
  const { payee, payeeVault, vault } = fixture;

  await vault.lockEscrow(payee.address, EXPECTED_HASH, 600, challengePeriod, ZERO_ADDRESS, { value: ONE_MON });
  await payeeVault.deliver(1n, RESULT_HASH);

  return fixture;
}

describe("AgentPayVault optimistic escrow", function () {
  it("stores the expected hash and binds delivery to its escrow context", async function () {
    const { ethers, payee, vault } = await lockAndDeliver();
    const escrow = await vault.escrows(1n);
    const boundHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "bytes32"], [1n, payee.address, RESULT_HASH]),
    );

    expect(escrow.expectedHash).to.equal(EXPECTED_HASH);
    expect(escrow.deliveryHash).to.equal(boundHash);
    expect(escrow.status).to.equal(1n); // Delivered
    expect(escrow.challengeDeadline).to.be.greaterThan(0n);
  });

  it("rejects an early claim and lets the payee claim after the challenge window", async function () {
    const { ethers, payeeVault, vault } = await lockAndDeliver();

    await expect(payeeVault.claim(1n)).to.be.revertedWith("AgentPay: window open");

    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);
    await expect(payeeVault.claim(1n)).to.emit(vault, "EscrowClaimed").withArgs(1n);

    expect((await vault.escrows(1n)).status).to.equal(2n); // Released
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
  });

  it("allows the payer to release a valid delivery immediately", async function () {
    const { ethers, payee, payerVault, vault } = await lockAndDeliver();
    const payeeBalanceBefore = await ethers.provider.getBalance(payee.address);

    await expect(payerVault.release(1n)).to.emit(vault, "EscrowReleased").withArgs(1n);

    expect((await vault.escrows(1n)).status).to.equal(2n); // Released
    expect(await ethers.provider.getBalance(payee.address)).to.equal(payeeBalanceBefore + ONE_MON);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
  });

  it("splits a disputed delivery 50/50 during the challenge window", async function () {
    const { ethers, payee, payerVault, vault } = await lockAndDeliver();
    const payeeBalanceBefore = await ethers.provider.getBalance(payee.address);

    await expect(payerVault.dispute(1n))
      .to.emit(vault, "EscrowDisputed")
      .withArgs(1n, ONE_MON / 2n, ONE_MON / 2n);

    expect((await vault.escrows(1n)).status).to.equal(4n); // Disputed
    expect(await ethers.provider.getBalance(payee.address)).to.equal(payeeBalanceBefore + ONE_MON / 2n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
  });

  it("refunds an undelivered escrow after its delivery deadline", async function () {
    const { callerVault, ethers, payee, vault } = await deployVault();
    await vault.lockEscrow(payee.address, EXPECTED_HASH, 60, 60, ZERO_ADDRESS, { value: ONE_MON });

    await expect(callerVault.refundExpired(1n)).to.be.revertedWith("AgentPay: not expired");
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);
    await expect(callerVault.refundExpired(1n)).to.emit(vault, "EscrowRefunded").withArgs(1n);

    expect((await vault.escrows(1n)).status).to.equal(3n); // Refunded
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
  });
});
